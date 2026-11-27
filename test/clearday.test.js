import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { airFromManualAqi, airFromExample } from '../lib/aqi.js';
import { buildDayPlan } from '../lib/dayplan.js';
import { estimateAvoidedCO2 } from '../lib/calc.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4391;
const BASE = `http://127.0.0.1:${PORT}`;

const personas = {
  walker: {
    mode: 'household', transport: 'walk', filtration: 'none', children: 1, adults: 2,
    sensitivities: ['asthma'], cookingFuel: 'lpg', heating: 'electric',
  },
  driver: {
    mode: 'household', transport: 'car', filtration: 'diy', children: 0, adults: 1,
    sensitivities: [], cookingFuel: 'lpg', heating: 'electric',
    commute: { carKm: 30, transitKm: 0, walkKm: 0, bikeKm: 0 },
  },
  organizer: {
    mode: 'community', transport: 'transit', filtration: 'hepa', children: 0, adults: 1,
    sensitivities: [], cookingFuel: 'electric', heating: 'electric',
  },
};

function ids(plan) {
  return Object.values(plan.dayPlan).flat().map((a) => a.id);
}

test('manual and example readings are labelled distinctly', () => {
  const manual = airFromManualAqi(175, 'Sensor on my street');
  const example = airFromExample();
  assert.equal(manual.sourceKind, 'manual');
  assert.equal(manual.place.name, 'Sensor on my street');
  assert.match(manual.note, /Manual/);
  assert.equal(example.sourceKind, 'example');
  assert.equal(example.aqi, 162);
  assert.match(example.note, /Illustrative/);
});

test('changing the profile changes the advice', () => {
  const air = airFromExample();
  const walker = buildDayPlan(personas.walker, air);
  const driver = buildDayPlan(personas.driver, air);
  const organizer = buildDayPlan(personas.organizer, air);
  const w = ids(walker); const d = ids(driver); const o = ids(organizer);

  assert.ok(w.includes('school-route'), `walker plan: ${w}`);
  assert.ok(w.includes('clean-room'));
  assert.ok(!w.includes('recirculate'));
  assert.ok(d.includes('recirculate'), `driver plan: ${d}`);
  assert.ok(d.includes('one-trip-transit'));
  assert.ok(!d.includes('school-route'));
  assert.ok(o.includes('community-alert'), `organizer plan: ${o}`);
  assert.ok(o.includes('carpool-rota'));
  assert.notDeepEqual(w, d);
  assert.notDeepEqual(d, o);

  const communityDriver = buildDayPlan({ ...personas.organizer, transport: 'car' }, air);
  const cd = ids(communityDriver);
  assert.ok(cd.includes('carpool-rota'));
  assert.ok(!cd.includes('community-carpool'));
});

test('every time slot has a no-cost option and actions carry sources', () => {
  const air = airFromExample();
  for (const profile of Object.values(personas)) {
    const plan = buildDayPlan(profile, air);
    for (const slot of ['morning', 'midday', 'evening']) {
      assert.ok(plan.dayPlan[slot].some((a) => a.noCost), `${slot} missing no-cost action for ${profile.mode}/${profile.transport}`);
    }
    for (const a of Object.values(plan.dayPlan).flat()) {
      assert.ok(a.what && a.why && a.typeLabel && a.source, `incomplete action ${a.id}`);
      assert.ok(!/air-cleaners-and-indoor-air-quality/i.test(a.sourceUrl || ''), `removed source on ${a.id}`);
    }
  }
  const sourcesText = JSON.stringify(buildDayPlan(personas.walker, air).library);
  assert.match(sourcesText, /ncdc\.mohfw\.gov\.in/);
  assert.match(sourcesText, /cpcb\.nic\.in/);
});

test('community sheet contains three actions and no personal data', () => {
  const sheet = buildDayPlan(personas.walker, airFromExample()).communitySheet;
  assert.equal(sheet.actions.length, 3);
  const text = JSON.stringify(sheet);
  assert.ok(!text.includes('sensitivities'));
  assert.ok(!text.includes('chat'));
  assert.ok(!text.includes('transport'));
  assert.ok(sheet.city && sheet.source && sheet.localTime);
});

test('zero trips produces a zero emissions estimate', () => {
  const zero = estimateAvoidedCO2(12, 0);
  assert.equal(zero.kgPerWeek, 0);
  assert.equal(zero.kgPerYear, 0);
  assert.match(zero.formula, /0 trips/);
  const normal = estimateAvoidedCO2(12, 3);
  assert.equal(normal.kgPerWeek, Math.round(12 * 3 * 0.192 * 100) / 100);
  assert.ok(normal.source.includes('DEFRA'));
});

async function spawnServer({ port = PORT, env = {} } = {}) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      LLM_API_KEY: '', OPENAI_API_KEY: '', ARK_API_KEY: '', GEMINI_API_KEY: '', LLM_PROVIDER: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 8000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('running at')) { clearTimeout(timer); resolve(); }
    });
    child.on('error', reject);
  });
  return child;
}

function stopServer(child) {
  if (child && !child.killed) child.kill('SIGTERM');
}

async function post(base, pathname, body) {
  const response = await fetch(base + pathname, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('API: manual reading, lookup failure, unavailable AI, calculator and assets', async (t) => {
  const server = await spawnServer();
  t.after(() => stopServer(server));

  const manual = await post(BASE, '/api/plan', { aqi: 175, city: 'My sensor', profile: personas.walker });
  assert.equal(manual.status, 200);
  assert.equal(manual.body.air.sourceText, 'Manual US AQI reading');
  assert.equal(manual.body.air.aqi, 175);

  const example = await post(BASE, '/api/plan', { example: true, profile: personas.organizer });
  assert.equal(example.body.air.sourceText, 'Example scenario');
  assert.equal(example.body.meta.llmAvailable, false);

  const failed = await post(BASE, '/api/plan', { city: 'zzzznotarealcityqqq', profile: personas.walker });
  assert.equal(failed.status, 400);
  assert.match(failed.body.error, /manual|location/i);

  const answer = await post(BASE, '/api/ask', { token: example.body.token, question: 'We walk to school and have no purifier. What can we change today?' });
  assert.equal(answer.status, 200);
  assert.equal(answer.body.source, 'rules');
  assert.match(answer.body.label, /Rules-based/);
  assert.match(answer.body.answer, /Source:/);

  const zero = await (await fetch(`${BASE}/api/calc?km=12&trips=0`)).json();
  assert.equal(zero.kgPerYear, 0);

  for (const asset of ['/', '/styles.css', '/app.js', '/winter-city.svg', '/shared/calc.js']) {
    const response = await fetch(BASE + asset);
    assert.equal(response.status, 200, asset);
    assert.ok((await response.text()).length > 50, asset);
  }
});

test('API security: validation, security headers, and cross-origin protection', async (t) => {
  const port = 4393;
  const base = `http://127.0.0.1:${port}`;
  const server = await spawnServer({ port });
  t.after(() => stopServer(server));

  const badAqi = await post(base, '/api/plan', { aqi: 'abc', profile: personas.walker });
  assert.equal(badAqi.status, 400);

  const outOfRangeCoords = await post(base, '/api/plan', { lat: 999, lon: 999, profile: personas.walker });
  assert.equal(outOfRangeCoords.status, 400);

  const crossOrigin = await fetch(`${base}/api/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ example: true }),
  });
  assert.equal(crossOrigin.status, 403);

  const health = await fetch(`${base}/api/health`);
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(health.headers.get('x-frame-options'), 'DENY');
  assert.equal(health.headers.get('access-control-allow-origin'), null);
  const healthBody = await health.json();
  assert.equal(healthBody.llm.enabled, false);
  assert.equal(healthBody.llm.baseUrl, null);
});

test('Doubao provider is detected and failed API calls fall back to rules', async (t) => {
  const port = 4392;
  const base = `http://127.0.0.1:${port}`;
  const server = await spawnServer({
    port,
    env: {
      LLM_PROVIDER: 'doubao',
      ARK_API_KEY: 'test-key-not-real',
      ARK_MODEL: 'doubao-seed-2-1-pro-260915',
      LLM_BASE_URL: 'http://127.0.0.1:9',
      LLM_TIMEOUT_MS: '800',
    },
  });
  t.after(() => stopServer(server));

  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.llm.enabled, true);
  assert.equal(health.llm.provider, 'Doubao (Volcengine Ark)');
  assert.equal(health.llm.model, 'doubao-seed-2-1-pro-260915');
  assert.equal(health.llm.baseUrl, 'http://127.0.0.1:9');

  const plan = await post(base, '/api/plan', { example: true, profile: personas.walker });
  assert.equal(plan.body.meta.llmAvailable, true);
  assert.equal(plan.body.meta.llmProvider, 'Doubao (Volcengine Ark)');

  const answer = await post(base, '/api/ask', {
    token: plan.body.token,
    question: 'I have a doubt about indoor air — what should we do tonight?',
  });
  assert.equal(answer.body.source, 'rules');
  assert.match(answer.body.label, /Rules-based/);
});

test('Gemini provider is auto-detected from GEMINI_API_KEY and falls back to rules on failure', async (t) => {
  const port = 4394;
  const base = `http://127.0.0.1:${port}`;
  const server = await spawnServer({
    port,
    env: {
      GEMINI_API_KEY: 'test-key-not-real',
      LLM_BASE_URL: 'http://127.0.0.1:9',
      LLM_TIMEOUT_MS: '800',
    },
  });
  t.after(() => stopServer(server));

  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.llm.enabled, true);
  assert.equal(health.llm.provider, 'Gemini (Google AI Studio)');
  assert.equal(health.llm.model, 'gemini-2.5-flash');

  const plan = await post(base, '/api/plan', { example: true, profile: personas.walker });
  const answer = await post(base, '/api/ask', {
    token: plan.body.token,
    question: 'Can we walk to school today?',
  });
  assert.equal(answer.body.source, 'rules');
});
