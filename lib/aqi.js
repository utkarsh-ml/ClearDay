import { EnvironmentError, getEnvironment } from './environment.js';
import { aqiCategory } from './standards.js';

const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';

// Coarse fallback coordinates for cities that commonly face severe smog.
export const OFFLINE_CITIES = [
  ['Delhi', 'India', 28.6139, 77.2090],
  ['Mumbai', 'India', 19.0760, 72.8777],
  ['Kolkata', 'India', 22.5726, 88.3639],
  ['Bengaluru', 'India', 12.9716, 77.5946],
  ['Chennai', 'India', 13.0827, 80.2707],
  ['Hyderabad', 'India', 17.3850, 78.4867],
  ['Ahmedabad', 'India', 23.0225, 72.5714],
  ['Pune', 'India', 18.5204, 73.8567],
  ['Jaipur', 'India', 26.9124, 75.7873],
  ['Lucknow', 'India', 26.8467, 80.9462],
  ['Kanpur', 'India', 26.4499, 80.3319],
  ['Varanasi', 'India', 25.3176, 82.9739],
  ['Patna', 'India', 25.5941, 85.1376],
  ['Chandigarh', 'India', 30.7333, 76.7794],
  ['Amritsar', 'India', 31.6340, 74.8723],
  ['Siliguri', 'India', 26.7271, 88.3953],
  ['Guwahati', 'India', 26.1445, 91.7362],
  ['Lahore', 'Pakistan', 31.5204, 74.3587],
  ['Karachi', 'Pakistan', 24.8607, 67.0011],
  ['Islamabad', 'Pakistan', 33.6844, 73.0479],
  ['Peshawar', 'Pakistan', 34.0151, 71.5800],
  ['Dhaka', 'Bangladesh', 23.8103, 90.4125],
  ['Kathmandu', 'Nepal', 27.7172, 85.3240],
  ['Colombo', 'Sri Lanka', 6.9271, 79.8612],
  ['Beijing', 'China', 39.9042, 116.4074],
  ['Shanghai', 'China', 31.2304, 121.4737],
  ['Jakarta', 'Indonesia', -6.2088, 106.8456],
  ['Hanoi', 'Vietnam', 21.0278, 105.8342],
  ['Bangkok', 'Thailand', 13.7563, 100.5018],
  ['Singapore', 'Singapore', 1.3521, 103.8198],
  ['Cairo', 'Egypt', 30.0444, 31.2357],
  ['Dubai', 'UAE', 25.2048, 55.2708],
  ['Tehran', 'Iran', 35.6892, 51.3890],
  ['Istanbul', 'Turkey', 41.0082, 28.9784],
  ['London', 'UK', 51.5074, -0.1278],
  ['Paris', 'France', 48.8566, 2.3522],
  ['Berlin', 'Germany', 52.5200, 13.4050],
  ['Madrid', 'Spain', 40.4168, -3.7038],
  ['Rome', 'Italy', 41.9028, 12.4964],
  ['Moscow', 'Russia', 55.7558, 37.6173],
  ['Los Angeles', 'USA', 34.0522, -118.2437],
  ['New York', 'USA', 40.7128, -74.0060],
  ['Toronto', 'Canada', 43.6532, -79.3832],
  ['Mexico City', 'Mexico', 19.4326, -99.1332],
  ['Sao Paulo', 'Brazil', -23.5505, -46.6333],
  ['Bogota', 'Colombia', 4.7110, -74.0721],
  ['Santiago', 'Chile', -33.4489, -70.6693],
  ['Johannesburg', 'South Africa', -26.2041, 28.0473],
  ['Lagos', 'Nigeria', 6.5244, 3.3792],
  ['Nairobi', 'Kenya', -1.2921, 36.8219],
  ['Sydney', 'Australia', -33.8688, 151.2093],
  ['Tokyo', 'Japan', 35.6762, 139.6503],
  ['Seoul', 'South Korea', 37.5665, 126.9780],
].map(([name, country, latitude, longitude]) => ({
  name, country, latitude, longitude,
}));

const geocodeCache = new Map();
const pendingCities = new Map();

function cacheGet(map, key, ttlMs) {
  const hit = map.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > ttlMs) {
    map.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(map, key, value) {
  map.set(key, { at: Date.now(), value });
  if (map.size > 200) map.delete(map.keys().next().value);
  return value;
}

async function getJSON(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(9000) });
  if (!response.ok) throw new Error(`Upstream returned ${response.status}`);
  return response.json();
}

function offlineMatches(query) {
  const q = query.trim().toLowerCase().split(',')[0].trim().replace(/^new delhi$/, 'delhi');
  if (!q) return [];
  const exact = OFFLINE_CITIES.filter((c) => c.name.toLowerCase() === q);
  if (exact.length) return exact;
  return OFFLINE_CITIES.filter(
    (c) => c.name.toLowerCase().includes(q) || c.country.toLowerCase().includes(q),
  ).slice(0, 5);
}

/** Resolve a place name (or "lat,lon") to coordinates. */
export async function searchCity(query) {
  const raw = String(query || '').trim();
  if (!raw) return [];

  const coordinateMatch = raw.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (coordinateMatch) {
    const latitude = Number(coordinateMatch[1]);
    const longitude = Number(coordinateMatch[2]);
    if (latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180) {
      return [{
        name: raw,
        country: 'Coordinates',
        latitude,
        longitude,
      }];
    }
    return [];
  }

  const key = raw.toLowerCase();
  const cached = cacheGet(geocodeCache, key, 24 * 60 * 60 * 1000);
  if (cached) return cached;

  if (pendingCities.has(key)) return pendingCities.get(key);
  const lookup = (async () => {
    try {
      const params = new URLSearchParams({ name: raw, count: '5', language: 'en', format: 'json' });
      const data = await getJSON(GEO_URL + '?' + params);
      const results = (data.results || []).filter(r => Number.isFinite(r.latitude) && Number.isFinite(r.longitude))
        .map(r => ({ name: r.name, country: r.country, region: r.admin1 || '', latitude: r.latitude, longitude: r.longitude }));
      return cacheSet(geocodeCache, key, results.length ? results : offlineMatches(raw));
    } catch {
      const offline = offlineMatches(raw);
      if (!offline.length) throw new EnvironmentError('City search is temporarily unavailable. Try a nearby city, coordinates or manual AQI.');
      return offline;
    }
  })();
  pendingCities.set(key, lookup);
  try { return await lookup; } finally { pendingCities.delete(key); }
}

// EPA/AirNow guidance for interpreting the US index. Each plan retains its source.
const guidance = {
  50: ['good', 'Outdoor air poses little pollution risk for most people.', 'Usual outdoor activities are generally fine.'],
  100: ['moderate', 'Most people can keep their usual outdoor routine.', 'If you are unusually sensitive to pollution, consider a shorter or gentler outdoor activity.'],
  150: ['sensitive', 'Sensitive groups may experience health effects.', 'Children, older adults and people with heart or lung conditions can take more breaks and reduce prolonged outdoor exertion.'],
  200: ['unhealthy', 'Health effects are possible across the population.', 'Reduce prolonged or intense outdoor activity. Sensitive groups should consider moving it indoors.'],
  300: ['very-unhealthy', 'Health risks are higher for everyone.', 'Avoid strenuous outdoor activities. Sensitive groups should move physical activity indoors.'],
  500: ['hazardous', 'Air pollution can affect everyone. Follow local emergency advisories.', 'Move physical activities indoors and seek a space with cleaner air.'],
};
function advisoryFor(aqi) {
  const band = aqiCategory('us', aqi);
  if (!band) return null;
  const [tone, general, sensitive] = guidance[band.max];
  return { label: band.label, color: band.color, tone, general, sensitive, sourceUrl: 'https://www.airnow.gov/aqi/aqi-basics/' };
}

// EPA 2024 24-hour PM2.5 breakpoints. The compatibility helper is never
// used to turn an instantaneous concentration into the dashboard's US AQI.
const PM_BREAKPOINTS = [
  [0, 9.0, 0, 50], [9.1, 35.4, 51, 100], [35.5, 55.4, 101, 150],
  [55.5, 125.4, 151, 200], [125.5, 225.4, 201, 300], [225.5, 325.4, 301, 500],
];
export function pm25ToAqi(pm) {
  const concentration = Math.floor(10 * Math.max(0, Number(pm) || 0)) / 10;
  for (const [low, high, from, to] of PM_BREAKPOINTS) {
    if (concentration <= high) return Math.round(from + (to - from) * (concentration - low) / (high - low));
  }
  return 500;
}

/** Pick the cleanest consecutive daylight 2-hour block for airing the home. */
export function findBestWindow(hourly) {
  const all = hourly || [];
  if (all.length < 2) return null;

  const isDaylight = (row) => {
    const hour = Number(String(row.time).slice(0, 2));
    return hour >= 7 && hour <= 20;
  };
  const consecutivePairs = [];
  for (let i = 0; i < all.length - 1; i += 1) {
    const hA = Number(String(all[i].time).slice(0, 2));
    const hB = Number(String(all[i + 1].time).slice(0, 2));
    if (!Number.isFinite(all[i].pm25) || !Number.isFinite(all[i + 1].pm25)) continue;
    if ((hB - hA + 24) % 24 !== 1) continue;
    consecutivePairs.push([all[i], all[i + 1]]);
  }
  const daylightPairs = consecutivePairs.filter(([a, b]) => isDaylight(a) && isDaylight(b));
  const pairs = (daylightPairs.length ? daylightPairs : consecutivePairs).slice(0, 13);
  if (!pairs.length) return null;

  let best = null;
  for (const [first, second] of pairs) {
    const avg = (first.pm25 + second.pm25) / 2;
    if (!best || avg < best.avgPm25) {
      best = {
        start: first.time,
        end: second.time,
        avgPm25: Math.round(avg),
        aqi: Number.isFinite(first.aqi) && Number.isFinite(second.aqi) ? Math.max(first.aqi, second.aqi) : null,
      };
    }
  }
  return best;
}

const pollutantLabels = { pm25: 'PM2.5', pm10: 'PM10', no2: 'NO₂', so2: 'SO₂', co: 'CO', o3: 'O₃' };

export async function getAirQuality(place) {
  const environment = await getEnvironment(place);
  const { current } = environment;
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: environment.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const hourly = environment.forecast.map(point => ({
    time: time.format(new Date(point.time)), pm25: point.pollutants.pm25, aqi: point.us,
  }));
  return {
    place, aqi: current.us, ...current.pollutants, hourly, environment,
    advisory: advisoryFor(current.us),
    dominant: current.usDominant ? { key: current.usDominant, name: pollutantLabels[current.usDominant], note: 'Highest modeled US AQI subindex' } : null,
    bestWindow: environment.stale ? null : findBestWindow(hourly),
    source: 'open-meteo', sourceKind: 'modeled',
    localTime: time.format(new Date(environment.asOf)), fetchedAt: environment.fetchedAt,
    note: environment.stale ? 'Showing the last available model update. A fresh reading is unavailable.' : null,
  };
}

export function aqiToPm25(aqi) {
  const value = Math.min(500, Math.max(0, Math.round(Number(aqi) || 0)));
  for (const [low, high, from, to] of PM_BREAKPOINTS) {
    if (value <= to) return Math.round(low + (high - low) * (value - from) / (to - from));
  }
}

function fixedAir({ aqi, name, country, source, sourceKind, note }) {
  const value = Math.min(500, Math.max(0, Math.round(Number(aqi) || 0)));
  const pm25 = sourceKind === 'example' ? aqiToPm25(value) : null;
  const now = new Date();
  return {
    place: { name, country, latitude: null, longitude: null },
    aqi: value,
    pm25,
    pm10: null,
    no2: null, o3: null, co: null, so2: null,
    hourly: [],
    advisory: advisoryFor(value),
    dominant: null,
    bestWindow: null,
    source,
    sourceKind,
    localTime: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    fetchedAt: now.toISOString(),
    note,
  };
}

/** Build an air reading from a user-entered local US AQI value. */
export function airFromManualAqi(aqi, label = 'Your local reading') {
  if (aqi === undefined || aqi === null || String(aqi).trim() === '' || !Number.isFinite(Number(aqi))) {
    throw new Error('Manual US AQI must be a number between 0 and 500.');
  }
  return fixedAir({
    aqi, name: label, country: 'Manual entry', source: 'manual', sourceKind: 'manual',
    note: 'Manual US AQI reading entered by you. Not independently verified.',
  });
}

/** Fixed demonstration scenario, clearly labelled as an example rather than live data. */
export function airFromExample() {
  return fixedAir({
    aqi: 162, name: 'Example winter morning', country: 'Example scenario',
    source: 'example', sourceKind: 'example',
    note: 'Illustrative scenario (US AQI 162). Not a live measurement.',
  });
}

export function describeSource(air) {
  if (air.sourceKind === 'manual') return 'Manual US AQI reading';
  if (air.sourceKind === 'example') return 'Example scenario';
  if (air.environment?.stale) return 'Cached modeled estimate · Open-Meteo (CAMS)';
  return 'Modeled estimate · Open-Meteo (CAMS)';
}
