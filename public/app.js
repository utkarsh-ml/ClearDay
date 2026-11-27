import { estimateAvoidedCO2 } from '/shared/calc.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const PREFS_KEY = 'clearday.preferences.v1';

const state = {
  plan: null,
  token: null,
  inputMode: 'search',
  place: null,
  noCost: false,
  selected: new Set(),
};

const esc = (value) => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

function safeUrl(raw) {
  if (!raw) return '';
  try {
    const parsed = new URL(String(raw), window.location.origin);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : '';
  } catch {
    return '';
  }
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 4000);
}

async function api(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

/* ---------------- status ---------------- */
async function loadStatus() {
  try {
    const health = await api('/api/health');
    const pill = $('#modePill');
    if (health.llm?.enabled) {
      pill.textContent = /gemini/i.test(health.llm.provider || '') ? 'Gemini AI guide ready' : 'AI guide available';
      pill.classList.remove('rules');
    } else {
      pill.textContent = 'Rules-based guide';
      pill.classList.add('rules');
    }
  } catch {
    $('#modePill').textContent = 'Guide status unknown';
  }
}

/* ---------------- preferences ---------------- */
function readProfile() {
  // The preferences section is not a <form>; read controls by name within it.
  const scope = $('#preferences');
  const mode = scope.querySelector('input[name="mode"]:checked')?.value || 'household';
  const transport = scope.querySelector('input[name="transport"]:checked')?.value || 'walk';
  const filtration = scope.querySelector('input[name="filtration"]:checked')?.value || 'none';
  const num = (name, fallback) => {
    const raw = scope.querySelector(`[name="${name}"]`)?.value;
    const val = raw === '' || raw === undefined ? fallback : Number(raw);
    return Math.min(12, Math.max(0, Number.isFinite(val) ? Math.round(val) : fallback));
  };
  const sensitivities = $$('#preferences input[name="sensitivity"]:checked').map((el) => el.value);
  return {
    mode, transport, filtration, sensitivities,
    adults: num('adults', 2), children: num('children', 1), elders: num('elders', 0),
    cookingFuel: 'lpg', heating: 'electric', cookingHours: 1.5,
    windows: 'always', sweeping: 'dry', indoorBurning: false, burningWaste: false,
    maskUse: 'never', redMeatMealsPerWeek: 2, currency: 'INR',
    commute: { carKm: transport === 'car' ? 20 : 0, transitKm: transport === 'transit' ? 15 : 0, walkKm: transport === 'walk' ? 4 : 1, bikeKm: transport === 'bike' ? 6 : 0 },
  };
}

function savePreferences() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(readProfile()));
    $('#savedNote').textContent = 'Saved in this browser · ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    $('#savedNote').textContent = 'Browser storage unavailable — preferences last for this visit only.';
  }
}

function loadPreferences() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null'); } catch { /* ignore */ }
  const scope = $('#preferences');
  const setRadio = (name, value) => {
    const el = scope.querySelector(`input[name="${name}"][value="${value}"]`);
    if (el) el.checked = true;
  };
  setRadio('mode', saved?.mode === 'community' ? 'community' : 'household');
  setRadio('transport', ['walk', 'bike', 'transit', 'car'].includes(saved?.transport) ? saved.transport : 'walk');
  setRadio('filtration', ['none', 'diy', 'hepa'].includes(saved?.filtration) ? saved.filtration : 'none');
  for (const name of ['adults', 'children', 'elders']) {
    const el = scope.querySelector(`[name="${name}"]`);
    if (el && Number.isFinite(saved?.[name])) el.value = Math.min(12, Math.max(0, saved[name]));
  }
  $$('#preferences input[name="sensitivity"]').forEach((el) => { el.checked = (saved?.sensitivities || []).includes(el.value); });
}

$$('#preferences input').forEach((el) => {
  el.addEventListener('change', savePreferences);
});

/* ---------------- input modes ---------------- */
function setInputMode(mode) {
  state.inputMode = mode;
  $$('.seg').forEach((b) => {
    const active = b.dataset.mode === mode;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  });
  $('#searchPanel').hidden = mode !== 'search';
  $('#manualPanel').hidden = mode !== 'manual';
  $('#examplePanel').hidden = mode !== 'example';
  $('#lookupError').hidden = true;
}

$$('.seg').forEach((btn) => btn.addEventListener('click', () => setInputMode(btn.dataset.mode)));

function showLookupError(message) {
  $('#lookupErrorText').textContent = message;
  $('#retryBtn').hidden = state.inputMode !== 'search';
  $('#lookupError').hidden = false;
}

$('#retryBtn').addEventListener('click', () => {
  $('#lookupError').hidden = true;
  $('#cityForm').requestSubmit();
});
$('#useManualBtn').addEventListener('click', () => {
  $$('.seg').find((b) => b.dataset.mode === 'manual').click();
  $('#manualAqi').focus();
});
$('#exampleBtn').addEventListener('click', () => submitPlan({ example: true }));

/* ---------------- city search ---------------- */
let searchTimer;
$('#cityInput').addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = $('#cityInput').value.trim();
  if (q.length < 2) { $('#suggestions').hidden = true; return; }
  searchTimer = setTimeout(async () => {
    try {
      const { results } = await api(`/api/geocode?q=${encodeURIComponent(q)}`);
      if (!results.length) { $('#suggestions').hidden = true; return; }
      $('#suggestions').innerHTML = results.map((r, i) => `<button type="button" role="option" data-index="${i}">${esc(r.name)} <small>— ${esc([r.region, r.country].filter(Boolean).join(', '))}</small></button>`).join('');
      $('#suggestions').hidden = false;
      $$('#suggestions button').forEach((btn) => btn.addEventListener('click', () => {
        state.place = results[Number(btn.dataset.index)];
        $('#cityInput').value = [state.place.name, state.place.country].filter(Boolean).join(', ');
        $('#suggestions').hidden = true;
        submitPlan(cityPayload());
      }));
    } catch {
      $('#suggestions').hidden = true;
      showLookupError('City lookup is unavailable right now. Retry, or enter your AQI reading manually.');
    }
  }, 320);
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.suggestions') && e.target !== $('#cityInput')) $('#suggestions').hidden = true;
});

const coordPattern = /^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/;
function cityPayload() {
  const typed = $('#cityInput').value.trim();
  const coord = typed.match(coordPattern);
  if (coord) return { lat: Number(coord[1]), lon: Number(coord[2]), city: typed };
  const place = state.place && typed.toLowerCase().startsWith(state.place.name.toLowerCase()) ? state.place : null;
  return place
    ? { city: place.name, lat: place.latitude, lon: place.longitude, label: [place.name, place.country].filter(Boolean).join(', ') }
    : { city: typed };
}

$('#cityForm').addEventListener('submit', (e) => {
  e.preventDefault();
  clearTimeout(searchTimer);
  $('#suggestions').hidden = true;
  if (!$('#cityInput').value.trim()) return toast('Enter a city name or coordinates.');
  submitPlan(cityPayload());
});

$('#manualForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const value = Number($('#manualAqi').value);
  if (!Number.isFinite(value) || value < 0 || value > 500) return toast('Enter a US AQI between 0 and 500.');
  submitPlan({ aqi: value, city: $('#manualLabel').value.trim() || 'Your local reading' });
});

/* ---------------- build plan ---------------- */
async function submitPlan(source) {
  const btn = $('#refreshBtn');
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Building plan…';
  $('#lookupError').hidden = true;
  try {
    const plan = await api('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...source, profile: readProfile() }),
    });
    state.plan = plan;
    state.token = plan.token;
    state.selected = new Set((plan.communitySheet?.actions || []).map((a) => a.id));
    renderAir(plan);
    renderPlan(plan);
    renderGuide(plan);
    savePreferences();
  } catch (error) {
    showLookupError(error.message + ' You can retry the search or enter a manual AQI reading.');
    toast(error.message);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

/* ---------------- air card ---------------- */
function renderAir(plan) {
  const air = plan.air;
  const manual = /manual/i.test(air.sourceText);
  const example = /example/i.test(air.sourceText);
  $('#airCity').textContent = air.city + (air.country ? `, ${air.country}` : '');
  $('#aqiNumber').textContent = air.aqi;
  $('#aqiMeaning').textContent = air.advisory?.general || air.advisory?.label || 'No advisory available.';
  $('#kindBadge').textContent = manual ? 'Manual reading' : example ? 'Example scenario' : 'Modeled estimate';
  $('#advisory').textContent = `Category: ${air.advisory?.label || 'unknown'}. ${air.advisory?.sensitive || ''}`;

  // Scale bands are 5 equal segments: 0–50, 51–100, 101–150, 151–200, 201+ (200 = 80%).
  const marker = $('#scaleMarker');
  marker.hidden = false;
  marker.style.left = `calc(${Math.min(99, Math.max(0, (air.aqi / 250) * 100))}% - 1px)`;

  const headline = $('#headlineAction');
  if (plan.headlineAction) {
    headline.hidden = false;
    headline.textContent = `Most relevant now: ${plan.headlineAction.what}`;
  } else headline.hidden = true;

  const href = safeUrl(air.sourceUrl);
  const sourceLink = href
    ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(air.sourceText)}</a>`
    : esc(air.sourceText);
  $('#sourceLine').innerHTML = `Source: ${sourceLink}`;
  $('#timeLine').textContent = `Local time: ${air.localTime || '—'}`;
  const note = $('#sourceNote');
  note.textContent = air.sourceNote || '';
  note.hidden = !air.sourceNote;
}

/* ---------------- daily plan ---------------- */
const SLOT_META = {
  morning: { icon: '🌤️', label: 'Morning' },
  midday: { icon: '☀️', label: 'Midday' },
  evening: { icon: '🌙', label: 'Evening' },
};

function visibleActions(plan) {
  const all = Object.values(plan.dayPlan).flat();
  return all.filter((a) => !state.noCost || a.noCost);
}

function renderPlan(plan) {
  const all = Object.values(plan.dayPlan).flat();
  const visible = visibleActions(plan);
  const visibleIds = new Set(visible.map((a) => a.id));
  for (const id of [...state.selected]) {
    if (!visibleIds.has(id)) state.selected.delete(id);
  }

  $('#planSummary').textContent = `${all.length} actions · ${all.filter((a) => a.noCost).length} need no equipment purchase`;

  $('#planBlocks').innerHTML = Object.entries(SLOT_META).map(([slot, meta]) => {
    const actions = visible.filter((a) => a.time === slot);
    if (!actions.length) {
      const emptyMsg = state.noCost
        ? 'No no-cost actions in this block. Turn off the filter to see all options.'
        : 'No extra changes needed in this time block for your current reading and routine.';
      return `<div class="time-block"><h3><span>${meta.icon}</span>${meta.label}</h3><p class="empty-state">${emptyMsg}</p></div>`;
    }
    return `<div class="time-block">
      <h3><span>${meta.icon}</span>${meta.label}</h3>
      ${actions.map((a) => actionCard(a)).join('')}
    </div>`;
  }).join('');

  $$('.plan-check input').forEach((box) => box.addEventListener('change', () => toggleAction(box.value, box.checked)));

  const impact = plan.impact;
  $('#impactStrip').hidden = false;
  $('#impactDose').textContent = `↓ ${impact.doseReductionPct}%`;
  $('#impactCo2').textContent = `${impact.co2Saved} kg/day`;
  $('#impactNote').textContent = state.noCost
    ? `Estimated from the full ${all.length}-action plan before filtering (${visible.length} no-cost actions shown). Not a personal health outcome or a predicted change in local AQI.`
    : `Estimated across the ${all.length} actions in this plan using the shared exposure model. Not a personal health outcome or a predicted change in local AQI.`;
  updateSelectionUI();
}

function actionCard(a) {
  const href = safeUrl(a.sourceUrl);
  const sourceTag = href
    ? `<span class="tag source"><a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(a.source)}</a></span>`
    : `<span class="tag source">${esc(a.source)}</span>`;
  return `<article class="action-card ${state.selected.has(a.id) ? 'selected' : ''}">
    <label class="plan-check"><input type="checkbox" value="${esc(a.id)}" ${state.selected.has(a.id) ? 'checked' : ''} aria-label="Select ${esc(a.what)} for community printout" /></label>
    <div class="action-body">
      <h4>${esc(a.what)}</h4>
      <p><strong>Why:</strong> ${esc(a.why)}</p>
      <div class="tags">
        <span class="tag ${esc(a.kind)}">${esc(a.typeLabel)}</span>
        <span class="tag ${a.noCost ? 'free' : ''}">${a.noCost ? 'No equipment purchase' : 'Needs equipment'}</span>
        ${sourceTag}
      </div>
    </div>
  </article>`;
}

function toggleAction(id, checked) {
  if (checked) {
    if (state.selected.size >= 3) {
      toast('Choose up to three actions for the printout.');
      const box = $$('.plan-check input').find((el) => el.value === id);
      if (box) box.checked = false;
      return;
    }
    state.selected.add(id);
  } else state.selected.delete(id);
  updateSelectionUI();
  const card = $$('.action-card').find((el) => el.querySelector('input')?.value === id);
  if (card) card.classList.toggle('selected', state.selected.has(id));
}

function updateSelectionUI() {
  const count = state.selected.size;
  $('#selectedCount').textContent = `${count} of 3 selected for print`;
  $('#printBtn').disabled = count !== 3;
  if (count < 3) $('#selectedCount').textContent += ' · select 3 to print';
  renderPrintSheet();
}

$('#noCostFilter').addEventListener('change', (e) => {
  state.noCost = e.target.checked;
  if (state.plan) renderPlan(state.plan);
});

$('#refreshBtn').addEventListener('click', () => {
  if (!state.plan) return toast('Choose a city or enter a reading first.');
  const air = state.plan.air;
  if (/manual/i.test(air.sourceText)) submitPlan({ aqi: state.plan.air.aqi, city: state.plan.air.city });
  else if (/example/i.test(air.sourceText)) submitPlan({ example: true });
  else submitPlan(cityPayload());
});

/* ---------------- guide ---------------- */
const SUGGESTIONS = [
  'We walk to school and have no purifier. What can we change today?',
  'I drive to work — what should I change?',
  'Which actions cost nothing?',
  'How do we share this with our school?',
];

function renderSuggestions(items = SUGGESTIONS) {
  const list = items.length ? items : SUGGESTIONS;
  $('#askSuggestions').innerHTML = list.map((q) => `<button type="button">${esc(q)}</button>`).join('');
  $$('#askSuggestions button').forEach((btn) => btn.addEventListener('click', () => {
    $('#askInput').value = btn.textContent;
    $('#askForm').requestSubmit();
  }));
}

function renderGuide(plan) {
  const badge = $('#guideBadge');
  badge.textContent = plan.meta.llmAvailable
    ? (/gemini/i.test(plan.meta.llmProvider || '') ? 'Gemini AI guide' : 'AI guide')
    : 'Rules-based';
  badge.classList.toggle('ai', Boolean(plan.meta.llmAvailable));
  const providerEl = $('#guideProvider');
  if (providerEl) {
    if (plan.meta.llmAvailable && plan.meta.llmProvider) {
      providerEl.textContent = `Provider: ${plan.meta.llmProvider}${plan.meta.llmModel ? ` (${plan.meta.llmModel})` : ''}`;
      providerEl.hidden = false;
    } else {
      providerEl.textContent = '';
      providerEl.hidden = true;
    }
  }
  $('#guideSub').textContent = plan.meta.llmAvailable
    ? 'Conversational AI answers grounded in today’s reading, your preferences and the sources shown on each action.'
    : 'AI model unavailable — answers use transparent rules, your plan and sourced guidance.';
  renderSuggestions(SUGGESTIONS);
}

function bubble(text, who) {
  const el = document.createElement('div');
  el.className = `bubble ${who}`;
  el.textContent = text;
  $('#chatLog').appendChild(el);
  $('#chatLog').scrollTop = $('#chatLog').scrollHeight;
  return el;
}

$('#askForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#askInput');
  const question = input.value.trim();
  if (!question) return;
  if (!state.token) return toast('Set a reading first, then ask a question.');
  bubble(question, 'user');
  input.value = '';
  const pending = bubble('Thinking…', 'bot');
  $('#askBtn').disabled = true;
  try {
    const answer = await api('/api/ask', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: state.token, question }),
    });
    pending.remove();
    if (answer.label) bubble(answer.label, 'bot');
    bubble(answer.answer, 'bot');
    if (Array.isArray(answer.followUps) && answer.followUps.length) {
      renderSuggestions(answer.followUps);
    }
  } catch (error) {
    pending.remove();
    bubble(error.message, 'error');
  } finally {
    $('#askBtn').disabled = false;
  }
});

/* ---------------- calculator ---------------- */
function renderCalc(result) {
  const zero = result.kgPerYear === 0;
  $('#calcResults').innerHTML = `
    <div class="result-row">
      <div><span>CO₂ avoided per week</span><strong>${result.kgPerWeek} kg</strong></div>
      <div><span>CO₂ avoided per year</span><strong>${result.kgPerYear} kg</strong></div>
    </div>
    <p class="formula">${esc(result.formula)}</p>
    ${zero ? '<p class="zero">Zero trips replaced means zero estimated tailpipe CO₂ avoided. No other effect is claimed.</p>' : ''}`;
  $('#calcAssumptions').innerHTML = result.assumptions.map((a) => `<li>${esc(a)}</li>`).join('');
  $('#calcSource').textContent = `Source: ${result.source}`;
}

$('#calcForm').addEventListener('submit', (e) => {
  e.preventDefault();
  renderCalc(estimateAvoidedCO2($('#calcKm').value, $('#calcTrips').value));
});

/* ---------------- printable community plan ---------------- */
function renderPrintSheet() {
  const plan = state.plan;
  if (!plan) { $('#printSheet').innerHTML = ''; return; }
  const chosen = Object.values(plan.library || {}).filter((a) => state.selected.has(a.id)).slice(0, 3);
  const ordered = chosen.length ? chosen : plan.communitySheet.actions;
  $('#printSheet').innerHTML = `
    <h1>Community clean-air plan</h1>
    <div class="print-meta">
      <strong>${esc(plan.air.city)}</strong> · US AQI ${plan.air.aqi} (${esc(plan.air.advisory?.label || '')})<br />
      Source: ${esc(plan.air.sourceText)} · Local time: ${esc(plan.air.localTime || '—')}
      ${plan.air.sourceNote ? `<br />${esc(plan.air.sourceNote)}` : ''}
    </div>
    <h2>Three actions for today</h2>
    <ol>${ordered.map((a) => `<li><strong>${esc(a.what || a.title)}</strong>
      <p>${esc(a.why)}</p>
      <p>Type: ${esc(a.typeLabel || a.kind || '')}${a.source ? ` · Source: ${esc(a.source)}` : ''}</p></li>`).join('')}</ol>
    <div class="print-foot">Prepared with ClearDay. Planning guidance only — follow local health advisories. No personal profile or conversation details are included.</div>`;
}

$('#printBtn').addEventListener('click', () => {
  if (!state.plan || state.selected.size !== 3) return;
  renderPrintSheet();
  window.print();
});

/* ---------------- boot ---------------- */
loadPreferences();
loadStatus();
renderCalc(estimateAvoidedCO2(12, 3));
setInputMode('example');
submitPlan({ example: true });
