import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironmentService, normalizeEnvironment } from '../lib/environment.js';

const place = { latitude: 28.6, longitude: 77.2 };
const modelHour = Date.parse('2026-01-12T13:30:00Z');
const now = modelHour + 25 * 60_000;
const fields = ['pm2_5', 'pm10', 'nitrogen_dioxide', 'sulphur_dioxide', 'carbon_monoxide', 'ozone'];

function fixture() {
  const time = Array.from({ length: 80 }, (_, index) => modelHour / 1000 + (index - 52) * 3600);
  const hourly = { time, us_aqi: time.map(() => 62) };
  const hourly_units = { time: 'unixtime', us_aqi: 'USAQI' };
  for (const field of fields) {
    hourly[field] = time.map(() => field === 'carbon_monoxide' ? 800 : 20);
    hourly['us_aqi_' + field] = time.map(() => field === 'pm10' ? 62 : 35);
    hourly_units[field] = 'μg/m³';
    hourly_units['us_aqi_' + field] = 'USAQI';
  }
  return { timezone: 'Asia/Kolkata', hourly, hourly_units };
}

test('current hour, relative yesterday and history use exact epoch times in a half-hour zone', () => {
  const data = fixture();
  data.hourly.pm2_5[52] = null;
  const result = normalizeEnvironment(data, place, 0, now);
  assert.equal(result.current.time, new Date(modelHour).toISOString());
  assert.equal(result.current.pollutants.pm25, null);
  assert.equal(result.current.us, 62);
  assert.equal(result.current.usDominant, 'pm10');
  assert.equal(result.forecast.length, 24);
  assert.equal(result.forecast[0].time, result.asOf);
  assert.equal(Date.parse(result.previousDay.time), modelHour - 24 * 3600_000);
  const history = normalizeEnvironment(data, place, 1, now);
  assert.equal(history.points.length, 24);
  assert.equal(Date.parse(history.points.at(-1).time), modelHour - 3600_000);
  assert.equal(history.points[0].time, result.previousDay.time);
});

test('null provider AQI is not inferred from particles and zero AQI remains zero', () => {
  const data = fixture();
  data.hourly.us_aqi[52] = null;
  let point = normalizeEnvironment(data, place, 0, now).current;
  assert.equal(point.us, null);
  assert.equal(point.usDominant, null);
  data.hourly.us_aqi[52] = 0;
  point = normalizeEnvironment(data, place, 0, now).current;
  assert.equal(point.us, 0);
  assert.equal(point.usDominant, null);
  data.hourly_units.pm10 = 'mg/m³';
  assert.throws(() => normalizeEnvironment(data, place, 0, now), /unit/);
});

test('duplicate requests share one upstream call and outages serve a bounded labeled stale copy', async () => {
  let clock = now, count = 0, fail = false;
  const service = createEnvironmentService(async () => {
    count++;
    if (fail) throw Error('offline');
    return Response.json(fixture());
  }, () => clock);
  const [first, parallel] = await Promise.all([service(place), service(place)]);
  assert.equal(count, 1);
  assert.deepEqual(parallel, first);
  await service(place);
  assert.equal(count, 1);
  clock += 20 * 60_000;
  fail = true;
  const stale = await service(place);
  assert.equal(stale.stale, true);
  assert.equal(stale.asOf, first.asOf);
  assert.equal(stale.fetchedAt, first.fetchedAt);
  clock += 7 * 3600_000;
  await assert.rejects(() => service(place), /could not be reached/);
});

test('rate-limited upstream stops repeated requests across places; malformed inputs fail before network', async () => {
  let count = 0;
  const service = createEnvironmentService(async () => {
    count++;
    return new Response(null, { status: 429, headers: { 'Retry-After': '90' } });
  }, () => now);
  await assert.rejects(service({ latitude: 91, longitude: 0 }), { status: 400 });
  await assert.rejects(service(place, 14), { status: 400 });
  await assert.rejects(service(place), { status: 429 });
  await assert.rejects(service({ latitude: 0, longitude: 0 }), { status: 429 });
  assert.equal(count, 1);
});
