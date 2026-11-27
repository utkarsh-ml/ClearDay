import { calculateCpcb } from './standards.js';

const AIR_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const HOUR = 3_600_000;
const fields = {
  pm25: 'pm2_5', pm10: 'pm10', no2: 'nitrogen_dioxide',
  so2: 'sulphur_dioxide', co: 'carbon_monoxide', o3: 'ozone',
};
const pollutantKeys = Object.fromEntries(Object.entries(fields).map(([key, field]) => [field, key]));
pollutantKeys.ammonia = 'nh3';
pollutantKeys.lead = 'pb';
const variables = [
  ...Object.values(fields), 'ammonia', 'us_aqi',
  ...Object.values(fields).map(field => 'us_aqi_' + field),
];
const number = value => Number.isFinite(value) && value >= 0 ? value : null;
const iso = seconds => new Date(seconds * 1000).toISOString();

export class EnvironmentError extends Error {
  constructor(message, status = 503) {
    super(message);
    this.status = status;
  }
}

function subindexKey(field) {
  return pollutantKeys[field] || null;
}

function pointAt(hourly, index, details = false) {
  const pollutants = {};
  const usSubindices = {};
  let dominant = null;
  for (const [key, field] of Object.entries(fields)) {
    pollutants[key] = number(hourly[field]?.[index]);
    const subindex = number(hourly['us_aqi_' + field]?.[index]);
    usSubindices[key] = subindex;
    if (subindex !== null && (dominant === null || subindex > usSubindices[dominant])) dominant = key;
  }
  const usValue = number(hourly.us_aqi?.[index]);
  const cpcb = calculateCpcb(hourly, index);
  const point = {
    time: iso(hourly.time[index]),
    us: usValue === null ? null : Math.round(usValue),
    in: cpcb.value,
    inLowerBound: cpcb.lowerBound ?? null,
    usDominant: dominant && usValue !== null && Math.round(usSubindices[dominant]) === Math.round(usValue) ? dominant : null,
    inDominant: subindexKey(cpcb.dominant),
    pollutants,
  };
  if (details) {
    point.inReason = cpcb.reason || null;
    point.usSubindices = usSubindices;
    point.inSubindices = Object.fromEntries(
      Object.entries(cpcb.subIndices || {}).filter(([field]) => subindexKey(field))
        .map(([field, value]) => [subindexKey(field), value]),
    );
  }
  return point;
}

// Open-Meteo returns hourly series on a local-hour grid. For India these can
// be half an hour off the UTC hour; use epoch comparison, not string equality.
export function normalizeEnvironment(data, place, days, now = Date.now()) {
  const hourly = data?.hourly;
  const times = hourly?.time || [];
  if (!Array.isArray(times) || !times.length || times.some((t, i) =>
    !Number.isSafeInteger(t) || t <= 0 || (i > 0 && t <= times[i - 1]))) {
    throw new EnvironmentError('The air provider returned an incomplete hourly series.');
  }
  // Reject unexpected units rather than attaching an incorrect unit label.
  for (const field of [...Object.values(fields), 'ammonia']) {
    if (Array.isArray(hourly[field]) && !['μg/m³', 'µg/m³'].includes(data.hourly_units?.[field])) {
      throw new EnvironmentError('The air provider returned an unrecognized pollutant unit.');
    }
  }
  const currentIndex = times.findLastIndex(seconds => seconds * 1000 <= now);
  if (currentIndex < 0 || now - times[currentIndex] * 1000 >= HOUR * 2) {
    throw new EnvironmentError('The provider has no current model hour for this area.');
  }
  const asOf = times[currentIndex];
  const meta = {
    timezone: data.timezone || 'UTC',
    asOf: iso(asOf), fetchedAt: new Date(now).toISOString(), stale: false,
    latitude: place.latitude, longitude: place.longitude,
    source: 'Open-Meteo · Copernicus Atmosphere Monitoring Service',
  };
  if (days) {
    const earliest = asOf - days * 86400;
    const points = [];
    for (let i = 0; i < currentIndex; i++) {
      if (times[i] >= earliest) points.push(pointAt(hourly, i));
    }
    if (!points.some(p => p.us !== null || p.in !== null || p.inLowerBound !== null || Object.values(p.pollutants).some(v => v !== null))) {
      throw new EnvironmentError('The provider has no historical values for this period.');
    }
    return { ...meta, points };
  }
  const current = pointAt(hourly, currentIndex, true);
  if (current.us === null && current.in === null && current.inLowerBound === null && Object.values(current.pollutants).every(v => v === null)) {
    throw new EnvironmentError('The provider has no current air-quality values for this location.');
  }
  const forecast = [];
  for (let i = currentIndex; i < times.length && times[i] < asOf + 86400; i++) {
    forecast.push(i === currentIndex ? current : pointAt(hourly, i));
  }
  const yesterday = times.indexOf(asOf - 86400);
  return { ...meta, current, forecast, previousDay: yesterday < 0 ? null : pointAt(hourly, yesterday) };
}

/** Keep memory bounded, collapse duplicate lookups, and retain genuine data for brief outages. */
export function createEnvironmentService(fetcher = fetch, clock = Date.now, report = () => {}) {
  const cache = new Map();
  const pending = new Map();
  const retryAt = new Map();
  let upstreamRetryAt = 0;
  let lastReport = -Infinity;

  async function refresh(place, days, key) {
    const params = new URLSearchParams({
      latitude: String(place.latitude), longitude: String(place.longitude),
      hourly: variables.join(','), timezone: 'auto', timeformat: 'unixtime',
      past_hours: String((days || 1) * 24 + 26), forecast_hours: days ? '2' : '25',
    });
    let response;
    try {
      response = await fetcher(AIR_URL + '?' + params, { signal: AbortSignal.timeout(12000) });
    } catch {
      throw new EnvironmentError('The air provider could not be reached. Try again in a moment.');
    }
    if (response.status === 429) {
      const delay = Number(response.headers.get('retry-after'));
      upstreamRetryAt = clock() + Math.min(3600, Math.max(30, Number.isFinite(delay) ? delay : 60)) * 1000;
      throw new EnvironmentError('The air provider is busy. Please try again shortly.', 429);
    }
    if (!response.ok) throw new EnvironmentError('The air provider is temporarily unavailable.');
    const result = normalizeEnvironment(await response.json(), place, days, clock());
    cache.delete(key);
    cache.set(key, result);
    if (cache.size > 80) cache.delete(cache.keys().next().value);
    return result;
  }

  return async function loadEnvironment(place, days = 0) {
    if (!Number.isFinite(place?.latitude) || !Number.isFinite(place.longitude) ||
        Math.abs(place.latitude) > 90 || Math.abs(place.longitude) > 180) {
      throw new EnvironmentError('Enter valid coordinates.', 400);
    }
    if (![0, 1, 7, 30].includes(days)) throw new EnvironmentError('Choose a 1, 7 or 30 day history.', 400);
    const key = [place.latitude.toFixed(3), place.longitude.toFixed(3), days].join(',');
    const hit = cache.get(key);
    const age = hit ? clock() - Date.parse(hit.fetchedAt) : Infinity;
    if (age < (days ? 30 : 10) * 60000 && clock() - Date.parse(hit.asOf) < HOUR) return hit;
    if (pending.has(key)) return pending.get(key);
    const request = (async () => {
      try {
        if (upstreamRetryAt > clock()) throw new EnvironmentError('The air provider is rate-limiting lookups. Try again shortly.', 429);
        if ((retryAt.get(key) || 0) > clock()) throw new EnvironmentError('The air provider is temporarily unavailable.');
        const data = await refresh(place, days, key);
        retryAt.delete(key);
        return data;
      } catch (error) {
        if (!(retryAt.get(key) > clock())) retryAt.set(key, clock() + 15_000);
        if (retryAt.size > 200) retryAt.delete(retryAt.keys().next().value);
        if (clock() - lastReport >= 60_000) {
          report(error instanceof EnvironmentError ? error.status : 503);
          lastReport = clock();
        }
        if (age <= (days ? 24 : 6) * HOUR) return { ...hit, stale: true };
        if (error instanceof EnvironmentError) throw error;
        throw new EnvironmentError('The air provider returned incomplete data. Try again shortly.');
      }
    })();
    pending.set(key, request);
    try { return await request; } finally { pending.delete(key); }
  };
}

// Never log coordinates, profiles, credentials or upstream query strings.
export const getEnvironment = createEnvironmentService(fetch, Date.now, status => {
  console.warn('[air provider] Temporary data failure (status %d)', status);
});
