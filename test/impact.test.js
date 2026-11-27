import test from 'node:test';
import assert from 'node:assert/strict';
import { pm25ToAqi, findBestWindow } from '../lib/aqi.js';
import {
  normalizeProfile, computeBaseline, buildActions, rankActions,
  selectPlan, simulateDose, summarize,
} from '../lib/impact.js';

const air = {
  aqi: 190, pm25: 92, pm10: 120, no2: 40, o3: 30, co: 900,
  hourly: [
    { time: '08:00', pm25: 130, aqi: 190 },
    { time: '09:00', pm25: 120, aqi: 180 },
    { time: '10:00', pm25: 70, aqi: 130 },
    { time: '11:00', pm25: 60, aqi: 115 },
    { time: '12:00', pm25: 80, aqi: 145 },
  ],
  bestWindow: { start: '10:00', end: '11:00', avgPm25: 65, aqi: 122 },
  advisory: { label: 'Unhealthy' },
  dominant: { name: 'PM2.5' },
  source: 'test',
};

const rawProfile = {
  adults: 2, children: 1, cookingFuel: 'biomass', cookingHours: 2,
  heating: 'wood', indoorBurning: true, purifier: 'none', windows: 'always',
  sweeping: 'dry', maskUse: 'never', burningWaste: true,
  commute: { carKm: 20, transitKm: 0, walkKm: 1, bikeKm: 0 },
  concerns: ['child-asthma'], currency: 'INR',
};

test('PM2.5 to AQI rises monotonically and stays in range', () => {
  assert.equal(pm25ToAqi(0), 0);
  assert.ok(pm25ToAqi(35) > pm25ToAqi(15));
  assert.ok(pm25ToAqi(300) > pm25ToAqi(100));
  assert.ok(pm25ToAqi(900) <= 500);
});

test('best ventilation window picks the cleanest consecutive pair', () => {
  const window = findBestWindow(air.hourly);
  assert.equal(window.start, '10:00');
  assert.equal(window.end, '11:00');
});

test('best ventilation window never pairs non-consecutive hours across overnight gaps', () => {
  const overnight = [
    { time: '19:00', pm25: 120, aqi: 180 },
    { time: '20:00', pm25: 30, aqi: 89 },
    { time: '21:00', pm25: 110, aqi: 175 },
    { time: '06:00', pm25: 100, aqi: 170 },
    { time: '07:00', pm25: 25, aqi: 78 },
    { time: '08:00', pm25: 40, aqi: 112 },
  ];
  const window = findBestWindow(overnight);
  assert.equal(window.start, '07:00');
  assert.equal(window.end, '08:00');
});

test('profile normalisation clamps invalid values and keeps defaults', () => {
  const p = normalizeProfile({ adults: 500, cookingFuel: 'plutonium', currency: 'XXX', concerns: 'child' });
  assert.equal(p.adults, 12);
  assert.equal(p.cookingFuel, 'lpg');
  assert.equal(p.currency, 'INR');
  assert.deepEqual(p.concerns, []);

  const zeroFuel = normalizeProfile({ cookingFuel: 'none', heating: 'none' });
  assert.equal(zeroFuel.cookingFuel, 'none');
  assert.equal(zeroFuel.heating, 'none');
});

test('baseline produces a plausible, positive household dose', () => {
  const p = normalizeProfile(rawProfile);
  const b = computeBaseline(p, air);
  assert.ok(b.totalDose > 0);
  assert.ok(b.indoorPM > b.outdoor * 0.5);
  assert.ok(b.bedroomPM > 0);
  assert.ok(b.sleepDose > 0 && b.activeDose > 0 && b.outdoorDose > 0);
  assert.ok(Math.abs(b.sleepDose + b.activeDose + b.outdoorDose - b.totalDose) < 1);
});

test('actions are tailored to the household and carry non-negative impacts', () => {
  const p = normalizeProfile(rawProfile);
  const b = computeBaseline(p, air);
  const actions = buildActions(p, air, b);
  const ids = new Set(actions.map((a) => a.id));
  for (const id of ['hepa-bedroom', 'clean-cooking', 'warm-layers', 'no-indoor-burning', 'mask', 'transit-swap', 'school-air-alert', 'no-burn-waste']) {
    assert.ok(ids.has(id), `expected ${id}`);
  }
  for (const a of actions) {
    assert.ok(a.doseSaved >= 0, `${a.id} dose`);
    assert.ok(a.title && a.why && a.detail);
  }
});

test('simulated combined dose never exceeds the sum of standalone savings', () => {
  const p = normalizeProfile(rawProfile);
  const b = computeBaseline(p, air);
  const actions = buildActions(p, air, b);
  const chosen = ['hepa-bedroom', 'vent-timing', 'wet-mop', 'no-indoor-burning'].map((id) => actions.find((a) => a.id === id));
  const combined = b.totalDose - simulateDose(chosen, b, p).total;
  const standalone = chosen.reduce((sum, a) => sum + a.doseSaved, 0);
  assert.ok(combined > 0);
  assert.ok(combined <= standalone + 1, `${combined} should be <= ${standalone}`);
});

test('summary stays bounded and matches a simulated plan', () => {
  const p = normalizeProfile(rawProfile);
  const b = computeBaseline(p, air);
  const actions = buildActions(p, air, b);
  const plan = selectPlan(rankActions(actions, p), 6);
  const result = summarize(plan, b, p);
  assert.ok(result.doseReductionPct >= 0 && result.doseReductionPct <= 85);
  assert.ok(result.doseAfter < b.totalDose);
  assert.equal(result.doseSaved, Math.round(b.totalDose - result.doseAfter));
  assert.ok(result.co2Saved >= 0);
});

test('must-include actions survive plan selection', () => {
  const p = normalizeProfile(rawProfile);
  const b = computeBaseline(p, air);
  const ranked = rankActions(buildActions(p, air, b), p);
  const plan = selectPlan(ranked, 6, { mustInclude: ['hepa-bedroom', 'mask'] });
  assert.equal(plan.length, 6);
  assert.ok(plan.some((a) => a.id === 'hepa-bedroom'));
  assert.ok(plan.some((a) => a.id === 'mask'));
  assert.equal(new Set(plan.map((a) => a.id)).size, 6);
});

test('a healthy household is not pushed irrelevant smoke actions', () => {
  const p = normalizeProfile({
    adults: 1, cookingFuel: 'electric', heating: 'electric', purifier: 'hepa',
    windows: 'brief', sweeping: 'wet', maskUse: 'always',
    commute: { carKm: 0, transitKm: 5, walkKm: 2, bikeKm: 0 },
    redMeatMealsPerWeek: 0, currency: 'USD',
  });
  const cleanAir = { ...air, aqi: 25, pm25: 6, bestWindow: null, advisory: { label: 'Good' } };
  const b = computeBaseline(p, cleanAir);
  const ids = buildActions(p, cleanAir, b).map((a) => a.id);
  for (const id of ['clean-cooking', 'warm-layers', 'mask', 'no-indoor-burning', 'transit-swap', 'no-idling']) {
    assert.ok(!ids.includes(id), `should not suggest ${id}`);
  }
  assert.ok(ids.includes('humidity'));
});
