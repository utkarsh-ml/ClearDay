import './lib/env.js';
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { gzip } from 'node:zlib';
import { searchCity, getAirQuality, airFromManualAqi, airFromExample } from './lib/aqi.js';
import { getEnvironment, EnvironmentError } from './lib/environment.js';
import { createPlan, answerQuestion } from './lib/plan.js';
import { presentAir } from './lib/dayplan.js';
import { estimateAvoidedCO2 } from './lib/calc.js';
import { llmInfo } from './lib/llm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.2';
const PLAN_TTL_MS = 2 * 60 * 60 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

const CSP_HEADER = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Short-lived store so the chat endpoint can reuse the exact verified plan and conversation turns.
const planStore = new Map();
function prunePlans(now = Date.now()) {
  for (const [k, v] of planStore) {
    if (now - v.at > PLAN_TTL_MS) planStore.delete(k);
  }
}
function storePlan(plan) {
  prunePlans();
  const token = randomUUID();
  planStore.set(token, { plan, at: Date.now(), history: [] });
  if (planStore.size > 200) planStore.delete(planStore.keys().next().value);
  return token;
}
function getPlanEntry(token) {
  const hit = planStore.get(token);
  if (!hit) return null;
  if (Date.now() - hit.at > PLAN_TTL_MS) {
    planStore.delete(token);
    return null;
  }
  return hit;
}

// Per-IP sliding-window rate limiter to protect upstream lookups and LLM quota.
const rateBuckets = new Map();
function allowRequest(req, bucket, limit, windowMs = 60_000) {
  const ip = req.socket?.remoteAddress || 'unknown';
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const hits = (rateBuckets.get(key) || []).filter((ts) => now - ts < windowMs);
  if (hits.length >= limit) {
    rateBuckets.set(key, hits);
    return false;
  }
  hits.push(now);
  rateBuckets.set(key, hits);
  if (rateBuckets.size > 500) {
    for (const [k, list] of rateBuckets) {
      if (!list.length || now - list[list.length - 1] >= windowMs) rateBuckets.delete(k);
    }
  }
  return true;
}

function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.host === req.headers.host;
  } catch {
    return false;
  }
}

function json(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  const headers = {
    ...SECURITY_HEADERS,
    ...(status === 429 ? { 'Retry-After': '60' } : {}),
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    Vary: 'Accept-Encoding',
  };
  const finish = (buffer, encoding) => {
    if (res.destroyed) return;
    if (encoding) headers['Content-Encoding'] = encoding;
    res.writeHead(status, { ...headers, 'Content-Length': buffer.length });
    res.end(buffer);
  };
  const gzipAllowed = String(res.req.headers['accept-encoding'] || '').split(',').some(entry => {
    const [codec, quality] = entry.trim().split(';').map(part => part.trim());
    return codec === 'gzip' && (!quality || Number(quality.replace(/^q=/, '')) > 0);
  });
  if (payload.length >= 4096 && gzipAllowed) {
    gzip(payload, { level: 4 }, (error, compressed) => {
      if (error) finish(payload); else finish(compressed, 'gzip');
    });
  } else finish(payload);
}

async function readBody(req, limit = 64_000) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Payload too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpError(400, 'JSON body must be an object');
    }
    return parsed;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, 'Invalid JSON body');
  }
}

function isValidCoordinates(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

async function resolvePlace({ city, lat, lon, label }) {
  const hasLat = lat !== null && lat !== undefined && String(lat).trim() !== '';
  const hasLon = lon !== null && lon !== undefined && String(lon).trim() !== '';
  if (hasLat || hasLon) {
    if (!hasLat || !hasLon) return null;
    const latitude = Number(lat);
    const longitude = Number(lon);
    if (!isValidCoordinates(latitude, longitude)) return null;
    return {
      name: String(label || city || `${latitude.toFixed(2)}, ${longitude.toFixed(2)}`).slice(0, 80),
      country: '', latitude, longitude,
    };
  }
  const query = String(city || '').trim().slice(0, 120);
  if (!query) return null;
  const hits = await searchCity(query);
  return hits[0] || null;
}

function parseManualAqi(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const num = Number(raw);
  if (!Number.isFinite(num) || num < 0 || num > 500) {
    throw new HttpError(400, 'Manual US AQI must be a number between 0 and 500.');
  }
  return num;
}

async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return json(res, 405, { error: 'Method not allowed' });
  }
  let relative;
  try {
    relative = decodeURIComponent(pathname);
  } catch {
    return json(res, 400, { error: 'Malformed URL path' });
  }
  if (relative.includes('\0') || relative.split('/').some((seg) => seg.startsWith('.'))) {
    return json(res, 403, { error: 'Forbidden' });
  }
  if (relative === '/' || relative === '') relative = '/index.html';
  const target = path.resolve(PUBLIC_DIR, `.${relative}`);
  if (!target.startsWith(PUBLIC_DIR + path.sep) && target !== PUBLIC_DIR) {
    return json(res, 403, { error: 'Forbidden' });
  }
  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error('Not a file');
    const data = await readFile(target);
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      ...(ext === '.html' ? { 'Content-Security-Policy': CSP_HEADER } : {}),
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
    });
    return res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    return json(res, 404, { error: 'Not found' });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const hostHeader = String(req.headers.host || 'localhost');
    if (!/^[A-Za-z0-9.\-:[\]]+$/.test(hostHeader)) {
      throw new HttpError(400, 'Invalid Host header');
    }
    let url;
    try {
      url = new URL(req.url || '/', `http://${hostHeader}`);
    } catch {
      throw new HttpError(400, 'Malformed request URL');
    }
    const pathname = url.pathname;

    if (req.method === 'POST' && !isSameOrigin(req)) {
      return json(res, 403, { error: 'Cross-origin POST requests are not permitted.' });
    }

    if (pathname === '/api/health' && req.method === 'GET') {
      return json(res, 200, { ok: true, llm: llmInfo, time: new Date().toISOString() });
    }

    if (pathname === '/api/geocode' && req.method === 'GET') {
      if (!allowRequest(req, 'geo', 60)) return json(res, 429, { error: 'Too many lookup requests. Please wait a moment.' });
      const q = String(url.searchParams.get('q') || '').trim().slice(0, 120);
      if (q.length < 2) return json(res, 200, { results: [] });
      return json(res, 200, { results: await searchCity(q) });
    }

    if (['/api/environment', '/api/history'].includes(pathname) && req.method === 'GET') {
      if (!allowRequest(req, 'environment', 50)) return json(res, 429, { error: 'Too many air-data requests. Please try again in a minute.' });
      const days = pathname === '/api/history' ? Number(url.searchParams.get('days') ?? 1) : 0;
      if (pathname === '/api/history' && ![1, 7, 30].includes(days)) throw new HttpError(400, 'Choose a history of 1, 7 or 30 days.');
      const lat = url.searchParams.get('lat');
      const lon = url.searchParams.get('lon');
      if (!lat?.trim() || !lon?.trim() || !isValidCoordinates(Number(lat), Number(lon))) {
        throw new HttpError(400, 'Select a city with valid coordinates.');
      }
      return json(res, 200, await getEnvironment({ latitude: Number(lat), longitude: Number(lon) }, days));
    }

    if (pathname === '/api/aqi' && req.method === 'GET') {
      if (!allowRequest(req, 'aqi', 60)) return json(res, 429, { error: 'Too many air-quality requests. Please wait a moment.' });
      if (url.searchParams.has('aqi')) {
        const aqi = parseManualAqi(url.searchParams.get('aqi'));
        if (aqi === null) return json(res, 400, { error: 'Enter a manual US AQI between 0 and 500.' });
        return json(res, 200, airFromManualAqi(aqi, String(url.searchParams.get('label') || 'Your local reading').slice(0, 80)));
      }
      if (url.searchParams.has('example')) return json(res, 200, airFromExample());
      const place = await resolvePlace({
        city: url.searchParams.get('city'),
        lat: url.searchParams.get('lat'),
        lon: url.searchParams.get('lon'),
      });
      if (!place) return json(res, 400, { error: 'Enter a valid city name or coordinates.' });
      return json(res, 200, await getAirQuality(place));
    }

    if (pathname === '/api/plan' && req.method === 'POST') {
      if (!allowRequest(req, 'plan', 60)) return json(res, 429, { error: 'Too many plan requests. Please wait a moment.' });
      const body = await readBody(req);
      let air;
      const manualAqi = parseManualAqi(body.aqi);
      if (manualAqi !== null) {
        air = airFromManualAqi(manualAqi, String(body.city || 'Your local reading').slice(0, 80));
      } else if (body.example) {
        air = airFromExample();
      } else {
        const place = await resolvePlace(body);
        if (!place) return json(res, 400, { error: 'We could not find that location. Try a nearby city or latitude,longitude, or enter a manual AQI.' });
        air = await getAirQuality(place);
      }
      if (air.aqi === null) {
        return json(res, 200, {
          planUnavailable: true, reason: 'US AQI is unavailable for the daily plan. You can enter a manual US reading.',
          token: null, air: presentAir(air),
        });
      }
      const plan = await createPlan(body.profile || {}, air);
      return json(res, 200, { ...plan, token: storePlan(plan) });
    }

    if (pathname === '/api/calc' && req.method === 'GET') {
      return json(res, 200, estimateAvoidedCO2(url.searchParams.get('km'), url.searchParams.get('trips')));
    }

    if (pathname === '/api/ask' && req.method === 'POST') {
      if (!allowRequest(req, 'ask', 20)) return json(res, 429, { error: 'Too many guide questions. Please wait a minute and try again.' });
      const body = await readBody(req);
      const question = String(body.question || '').trim().slice(0, 600);
      if (!question) return json(res, 400, { error: 'Ask a question first.' });
      const entry = getPlanEntry(String(body.token || ''));
      if (!entry) return json(res, 410, { error: 'This plan has expired. Generate a new one and try again.' });
      const reply = await answerQuestion(question, entry.plan, entry.history);
      entry.history.push(
        { role: 'user', content: question },
        { role: 'assistant', content: reply.answer },
      );
      if (entry.history.length > 10) entry.history = entry.history.slice(-10);
      return json(res, 200, reply);
    }

    if (['/shared/calc.js', '/shared/standards.js'].includes(pathname) && (req.method === 'GET' || req.method === 'HEAD')) {
      const data = await readFile(path.join(__dirname, 'lib', path.basename(pathname)));
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': MIME['.js'],
        'Content-Length': data.length,
        'Cache-Control': 'public, max-age=300',
      });
      return res.end(req.method === 'HEAD' ? undefined : data);
    }

    if (pathname.startsWith('/api/')) return json(res, 404, { error: 'Unknown endpoint' });
    return serveStatic(req, res, pathname);
  } catch (error) {
    if (error instanceof HttpError || error instanceof EnvironmentError) {
      return json(res, error.status, { error: error.message });
    }
    console.error('[server error]', error?.message || 'Unexpected error');
    return json(res, 500, { error: 'Something went wrong while processing that request.' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`ClearDay running at http://${HOST}:${PORT}`);
  console.log(`AI guide: ${llmInfo.enabled ? `enabled (${llmInfo.provider}: ${llmInfo.model})` : 'not configured — using rules-based guide'}`);
});
