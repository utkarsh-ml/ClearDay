/**
 * Optional GenAI layer. Supports:
 * - Google Gemini Free Tier (GEMINI_API_KEY -> OpenAI-compatible endpoint)
 * - Doubao / Volcengine Ark (ARK_API_KEY / LLM_PROVIDER=doubao)
 * - OpenAI or any OpenAI-compatible /v1/chat/completions API (LLM_API_KEY, LLM_BASE_URL, LLM_MODEL)
 *
 * Keys stay strictly on the server. If no key is configured (or the call fails),
 * callers fall back to the deterministic rules-based guide in plan.js.
 */

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_FALLBACK_MODELS = ['gemini-3.8-flash', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-flash-lite', 'gemini-3.5-flash-lite'];
const ARK_DEFAULT_URL = 'https://ark.cn-beijing.volces.com/api/v3';
const ARK_DEFAULT_MODEL = 'doubao-seed-2-1-pro-260915';
const OPENAI_DEFAULT_URL = 'https://api.openai.com/v1';
const OPENAI_DEFAULT_MODEL = 'gpt-4o-mini';

const explicitProvider = (process.env.LLM_PROVIDER || '').trim().toLowerCase();
const geminiKey = (process.env.GEMINI_API_KEY || '').trim();
const arkKey = (process.env.ARK_API_KEY || '').trim();
const genericKey = (process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '').trim();

const providerKind = explicitProvider
  || (genericKey ? 'openai' : geminiKey ? 'gemini' : arkKey ? 'doubao' : 'openai');

const API_KEY = providerKind === 'doubao'
  ? (genericKey || arkKey)
  : providerKind === 'gemini'
    ? (genericKey || geminiKey)
    : (genericKey || geminiKey || arkKey);

const BASE_URL = (
  process.env.LLM_BASE_URL
  || (providerKind === 'doubao'
    ? (process.env.ARK_BASE_URL || ARK_DEFAULT_URL)
    : providerKind === 'gemini'
      ? GEMINI_BASE_URL
      : OPENAI_DEFAULT_URL)
).trim().replace(/\/+$/, '');

const CONFIGURED_MODEL = (
  process.env.LLM_MODEL
  || (providerKind === 'doubao'
    ? (process.env.ARK_MODEL || ARK_DEFAULT_MODEL)
    : providerKind === 'gemini'
      ? DEFAULT_GEMINI_MODEL
      : OPENAI_DEFAULT_MODEL)
).trim();

let activeModel = CONFIGURED_MODEL;

const THINKING_MODE = (process.env.LLM_THINKING || '').trim().toLowerCase();
const TIMEOUT_MS = Math.min(60_000, Math.max(2000, Number(process.env.LLM_TIMEOUT_MS || 20000) || 20000));

function sanitizeBaseUrl(raw) {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    return null;
  }
}

const PROVIDER_LABELS = {
  gemini: 'Gemini (Google AI Studio)',
  doubao: 'Doubao (Volcengine Ark)',
  openai: 'OpenAI-compatible',
};

export const llmEnabled = Boolean(API_KEY);
export const llmInfo = {
  enabled: llmEnabled,
  provider: llmEnabled ? (PROVIDER_LABELS[providerKind] || 'OpenAI-compatible') : null,
  model: llmEnabled ? CONFIGURED_MODEL : null,
  baseUrl: llmEnabled ? sanitizeBaseUrl(BASE_URL) : null,
};

function sanitizeErrorText(reason) {
  let s = String(reason || '').trim();
  if (API_KEY) s = s.replaceAll(API_KEY, '[REDACTED]');
  s = s.replace(/AIza[0-9A-Za-z_-]{10,}/g, '[REDACTED]');
  return s.slice(0, 180);
}

function logLlmFailure(reason) {
  const safe = sanitizeErrorText(reason);
  console.warn(`[llm] ${providerKind} (${activeModel}) fallback to rules: ${safe}`);
  return safe;
}

function cleanJSON(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(s.slice(first, last + 1));
    } catch {
      // Fall through to plain-text fallback when model ignores JSON formatting.
    }
  }
  if (!s.startsWith('{') && s.length >= 10) {
    return { answer: s, followUps: [] };
  }
  throw new Error('Malformed JSON response from model');
}

async function postChat(body, signal) {
  return fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
    signal,
  });
}

async function readErrorDetail(response) {
  let detail = `HTTP ${response.status}`;
  try {
    const errBody = await response.json();
    const msg = errBody?.error?.message || errBody?.[0]?.error?.message;
    if (msg) detail += `: ${sanitizeErrorText(msg)}`;
  } catch { /* ignore non-JSON error body */ }
  return detail;
}

async function discoverGeminiFlashModel(signal) {
  try {
    const res = await fetch(`${BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    const ids = (data.data || [])
      .map((m) => String(m.id || '').replace(/^models\//, ''))
      .filter((id) => /gemini/i.test(id) && /flash/i.test(id) && !/image|tts|audio|live|embedding/i.test(id));
    for (const preferred of GEMINI_FALLBACK_MODELS) {
      if (ids.includes(preferred)) return preferred;
    }
    return ids[0] || null;
  } catch {
    return null;
  }
}

async function complete(messages, { json = true, maxTokens = 2048 } = {}) {
  if (!llmEnabled) return { ok: false, error: null };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const buildBody = (model, withOptional = true) => {
      const body = {
        model,
        messages,
        temperature: 0.6,
        max_tokens: maxTokens,
      };
      if (withOptional && json) body.response_format = { type: 'json_object' };
      if (providerKind === 'doubao' && THINKING_MODE === 'disabled') {
        body.thinking = { type: 'disabled' };
      }
      if (withOptional && providerKind === 'gemini' && THINKING_MODE !== 'default') {
        body.reasoning_effort = 'low';
      }
      return body;
    };

    let response = await postChat(buildBody(activeModel, true), controller.signal);

    if (!response.ok && response.status === 400) {
      response = await postChat(buildBody(activeModel, false), controller.signal);
    }

    // If the default Gemini model name isn't enabled on this key/version, auto-discover a working Flash model.
    if (!response.ok && response.status === 404 && providerKind === 'gemini' && !process.env.LLM_MODEL) {
      const discovered = await discoverGeminiFlashModel(controller.signal);
      const candidates = [discovered, ...GEMINI_FALLBACK_MODELS].filter((m, i, arr) => m && m !== activeModel && arr.indexOf(m) === i);
      for (const candidate of candidates) {
        const retry = await postChat(buildBody(candidate, false), controller.signal);
        if (retry.ok) {
          activeModel = candidate;
          llmInfo.model = candidate;
          response = retry;
          break;
        }
      }
    }

    if (!response.ok) {
      const detail = await readErrorDetail(response);
      return { ok: false, error: logLlmFailure(detail) };
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) {
      const reason = `Empty completion (finish_reason: ${data.choices?.[0]?.finish_reason || 'unknown'})`;
      return { ok: false, error: logLlmFailure(reason) };
    }
    return { ok: true, data: json ? cleanJSON(text) : { text: String(text).trim() } };
  } catch (err) {
    const reason = err?.name === 'AbortError' ? `Timed out after ${TIMEOUT_MS}ms` : (err?.message || 'Request failed');
    return { ok: false, error: logLlmFailure(reason) };
  } finally {
    clearTimeout(timer);
  }
}

const COACH_RULES = `
You are ClearDay, a warm, practical air-quality chatbot and day-planning coach for families and community organisers.
Rules:
- Use only the numbers, reading metadata, and actions given in the context. Never invent statistics, percentages, costs or medical facts.
- Discuss naturally across follow-up turns in plain language, short sentences, kind and non-judgemental. No scaremongering.
- Do not diagnose or prescribe. Say "seek medical advice" only for clear warning symptoms.
- Respect that households have different budgets and constraints. Offer a low-cost angle where possible.
- Return ONLY valid JSON with the exact keys requested. No markdown fences.`;

export async function askAssistant({ question, context, history = [] }) {
  const safeHistory = Array.isArray(history)
    ? history
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
        .slice(-8)
        .map((m) => ({ role: m.role, content: m.content.trim().slice(0, 800) }))
    : [];

  return complete([
    {
      role: 'system',
      content: `${COACH_RULES}
Answer the user's practical winter-air question in under 150 words. Ground every claim in the supplied context and prior conversation. Name the source label from the context when you use sourced guidance (for example "Source: MoHFW / NCDC India indoor air & health advisory (NPCCHH)" or "Source: CPCB India National Air Quality Index"). Never claim a change in local AQI or a personal health outcome. If asked about cost, say clearly whether an option needs equipment. If something is not in the context, say what you would need to know.

PLAN CONTEXT (JSON):
${JSON.stringify(context)}`,
    },
    ...safeHistory,
    {
      role: 'user',
      content: `QUESTION: ${question}\n\nReturn JSON exactly like:\n{ "answer": "...", "followUps": ["short follow-up question", "short follow-up question"] }`,
    },
  ], { json: true, maxTokens: 2048 });
}
