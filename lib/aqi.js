/**
 * Location + air-quality lookup.
 *
 * Uses the free, key-less Open-Meteo Air Quality and Geocoding APIs.
 * If the network is unavailable, a small offline gazetteer + clearly
 * labelled estimate keeps the assistant usable for common smog cities.
 */

const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const AIR_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';

// Coarse fallback coordinates for cities that commonly face severe smog.
export const OFFLINE_CITIES = [
  ['Delhi', 'India', 28.6139, 77.2090, 190],
  ['Mumbai', 'India', 19.0760, 72.8777, 95],
  ['Kolkata', 'India', 22.5726, 88.3639, 150],
  ['Bengaluru', 'India', 12.9716, 77.5946, 80],
  ['Chennai', 'India', 13.0827, 80.2707, 70],
  ['Hyderabad', 'India', 17.3850, 78.4867, 100],
  ['Ahmedabad', 'India', 23.0225, 72.5714, 130],
  ['Pune', 'India', 18.5204, 73.8567, 95],
  ['Jaipur', 'India', 26.9124, 75.7873, 145],
  ['Lucknow', 'India', 26.8467, 80.9462, 175],
  ['Kanpur', 'India', 26.4499, 80.3319, 205],
  ['Varanasi', 'India', 25.3176, 82.9739, 165],
  ['Patna', 'India', 25.5941, 85.1376, 185],
  ['Chandigarh', 'India', 30.7333, 76.7794, 160],
  ['Amritsar', 'India', 31.6340, 74.8723, 175],
  ['Siliguri', 'India', 26.7271, 88.3953, 155],
  ['Guwahati', 'India', 26.1445, 91.7362, 120],
  ['Lahore', 'Pakistan', 31.5204, 74.3587, 210],
  ['Karachi', 'Pakistan', 24.8607, 67.0011, 125],
  ['Islamabad', 'Pakistan', 33.6844, 73.0479, 145],
  ['Peshawar', 'Pakistan', 34.0151, 71.5800, 190],
  ['Dhaka', 'Bangladesh', 23.8103, 90.4125, 180],
  ['Kathmandu', 'Nepal', 27.7172, 85.3240, 150],
  ['Colombo', 'Sri Lanka', 6.9271, 79.8612, 75],
  ['Beijing', 'China', 39.9042, 116.4074, 130],
  ['Shanghai', 'China', 31.2304, 121.4737, 85],
  ['Jakarta', 'Indonesia', -6.2088, 106.8456, 140],
  ['Hanoi', 'Vietnam', 21.0278, 105.8342, 155],
  ['Bangkok', 'Thailand', 13.7563, 100.5018, 110],
  ['Singapore', 'Singapore', 1.3521, 103.8198, 55],
  ['Cairo', 'Egypt', 30.0444, 31.2357, 135],
  ['Dubai', 'UAE', 25.2048, 55.2708, 85],
  ['Tehran', 'Iran', 35.6892, 51.3890, 145],
  ['Istanbul', 'Turkey', 41.0082, 28.9784, 95],
  ['London', 'UK', 51.5074, -0.1278, 55],
  ['Paris', 'France', 48.8566, 2.3522, 50],
  ['Berlin', 'Germany', 52.5200, 13.4050, 40],
  ['Madrid', 'Spain', 40.4168, -3.7038, 45],
  ['Rome', 'Italy', 41.9028, 12.4964, 50],
  ['Moscow', 'Russia', 55.7558, 37.6173, 60],
  ['Los Angeles', 'USA', 34.0522, -118.2437, 70],
  ['New York', 'USA', 40.7128, -74.0060, 55],
  ['Toronto', 'Canada', 43.6532, -79.3832, 45],
  ['Mexico City', 'Mexico', 19.4326, -99.1332, 105],
  ['Sao Paulo', 'Brazil', -23.5505, -46.6333, 65],
  ['Bogota', 'Colombia', 4.7110, -74.0721, 80],
  ['Santiago', 'Chile', -33.4489, -70.6693, 75],
  ['Johannesburg', 'South Africa', -26.2041, 28.0473, 85],
  ['Lagos', 'Nigeria', 6.5244, 3.3792, 125],
  ['Nairobi', 'Kenya', -1.2921, 36.8219, 70],
  ['Sydney', 'Australia', -33.8688, 151.2093, 30],
  ['Tokyo', 'Japan', 35.6762, 139.6503, 40],
  ['Seoul', 'South Korea', 37.5665, 126.9780, 65],
].map(([name, country, latitude, longitude, baseline]) => ({
  name, country, latitude, longitude, baseline,
}));

const geocodeCache = new Map();
const airCache = new Map();

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
  const q = query.trim().toLowerCase();
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

  try {
    const data = await getJSON(`${GEO_URL}?name=${encodeURIComponent(raw)}&count=5&language=en&format=json`);
    const results = (data.results || []).map((r) => ({
      name: r.name,
      country: r.country,
      region: r.admin1 || '',
      latitude: r.latitude,
      longitude: r.longitude,
    }));
    if (results.length) return cacheSet(geocodeCache, key, results);
  } catch {
    // fall through to offline gazetteer
  }
  return cacheSet(geocodeCache, key, offlineMatches(raw));
}

function advisoryFor(aqi) {
  const a = Number(aqi) || 0;
  if (a <= 50) return {
    label: 'Good', color: '#2e9e6b', tone: 'good',
    general: 'Air is clean. A great day for open windows, outdoor play and a walk.',
    sensitive: 'Enjoy the outdoors — no special precautions needed.',
  };
  if (a <= 100) return {
    label: 'Moderate', color: '#d2a51a', tone: 'moderate',
    general: 'Acceptable for most people. Long outdoor workouts may affect children and people with asthma.',
    sensitive: 'Sensitive group? Shorten strenuous outdoor sessions and watch for symptoms.',
  };
  if (a <= 150) return {
    label: 'Unhealthy for sensitive groups', color: '#e2812b', tone: 'sensitive',
    general: 'Children, older adults, pregnant people and those with heart or lung conditions should ease up outdoors.',
    sensitive: 'Keep vigorous play indoors. Use a well-fitted mask outside and run a purifier at home.',
  };
  if (a <= 200) return {
    label: 'Unhealthy', color: '#d95a3d', tone: 'unhealthy',
    general: 'Everyone should cut down on prolonged outdoor exertion. Keep windows closed at busy-road times.',
    sensitive: 'Stay indoors with filtered air as much as possible; move planned exercise inside.',
  };
  if (a <= 300) return {
    label: 'Very unhealthy', color: '#a64bc4', tone: 'very-unhealthy',
    general: 'Health alert: avoid outdoor exertion, keep indoor air filtered and check on neighbours.',
    sensitive: 'Remain indoors with clean air. Seek medical advice if you feel breathless, dizzy or chest-tight.',
  };
  return {
    label: 'Hazardous', color: '#8c2f3a', tone: 'hazardous',
    general: 'Emergency conditions. Stay indoors with filtered air and follow local government advisories.',
    sensitive: 'Do not go outside unless essential. Contact local health services if symptoms appear.',
  };
}

/** Relative pollution burden, used to name the main concern without pretending to compute a full sub-index. */
function dominantPollutant(current) {
  const guidelines = [
    ['pm25', 15, 'PM2.5', 'fine particles'],
    ['pm10', 45, 'PM10', 'coarse dust'],
    ['nitrogen_dioxide', 25, 'NO₂', 'traffic gas'],
    ['ozone', 100, 'O₃', 'ground-level ozone'],
    ['carbon_monoxide', 4000, 'CO', 'combustion gas'],
  ];
  let best = { key: 'pm25', name: 'PM2.5', note: 'fine particles', ratio: 0 };
  for (const [key, limit, name, note] of guidelines) {
    const value = Number(current?.[key]);
    if (!Number.isFinite(value)) continue;
    const ratio = value / limit;
    if (ratio > best.ratio) best = { key, name, note, ratio };
  }
  return best;
}

function fallbackAir(place) {
  const base = place?.baseline || 120;
  const hour = new Date().getHours();
  // Diurnal shape: morning and evening peaks, cleaner mid-afternoon.
  const shape = 1 + 0.18 * Math.cos(((hour - 8) / 24) * 2 * Math.PI) - 0.16 * Math.cos(((hour - 15) / 12) * 2 * Math.PI);
  const pm25 = Math.max(8, Math.round(base * shape));
  const now = new Date();
  const hourly = [];
  for (let i = 0; i < 24; i += 1) {
    const d = new Date(now.getTime() + i * 3600_000);
    const h = d.getHours();
    const s = 1 + 0.2 * Math.cos(((h - 8) / 24) * 2 * Math.PI) - 0.18 * Math.cos(((h - 15) / 12) * 2 * Math.PI);
    const value = Math.max(6, Math.round(base * s));
    hourly.push({
      time: `${String(h).padStart(2, '0')}:00`,
      pm25: value,
      aqi: pm25ToAqi(value),
    });
  }
  const aqi = pm25ToAqi(pm25);
  return {
    place,
    aqi,
    pm25,
    pm10: Math.round(pm25 * 1.15),
    no2: Math.round(pm25 * 0.4),
    o3: Math.round(pm25 * 0.5),
    co: Math.round(pm25 * 12),
    hourly,
    advisory: advisoryFor(aqi),
    dominant: { name: 'PM2.5', note: 'fine particles', ratio: pm25 / 15 },
    bestWindow: findBestWindow(hourly),
    source: 'offline-estimate',
    sourceKind: 'modeled',
    localTime: `${String(hour).padStart(2, '0')}:00`,
    fetchedAt: new Date().toISOString(),
    note: 'Live data unavailable — showing a modelled estimate for this city. Connect to the internet for current readings.',
  };
}

/** US EPA PM2.5 breakpoints (simplified, 24h-style conversion used only as a display estimate). */
export function pm25ToAqi(pm) {
  const breakpoints = [
    [0, 12.0, 0, 50], [12.1, 35.4, 51, 100], [35.5, 55.4, 101, 150],
    [55.5, 125.4, 151, 200], [125.5, 225.4, 201, 300], [225.5, 325.4, 301, 400],
    [325.5, 500.4, 401, 500],
  ];
  const c = Math.max(0, Number(pm) || 0);
  for (const [cl, ch, al, ah] of breakpoints) {
    if (c <= ch) return Math.round(al + ((ah - al) / (ch - cl)) * (c - cl));
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
        aqi: pm25ToAqi(avg),
      };
    }
  }
  return best;
}

/** Fetch current readings + a short hourly outlook for one coordinate pair. */
export async function getAirQuality(place) {
  if (!place || !Number.isFinite(place.latitude) || !Number.isFinite(place.longitude)) {
    throw new Error('A location with latitude and longitude is required.');
  }
  const key = `${place.latitude.toFixed(3)},${place.longitude.toFixed(3)}`;
  const cached = cacheGet(airCache, key, 10 * 60 * 1000);
  if (cached) return { ...cached, place };

  const params = new URLSearchParams({
    latitude: String(place.latitude),
    longitude: String(place.longitude),
    current: 'pm2_5,pm10,nitrogen_dioxide,ozone,carbon_monoxide,us_aqi',
    hourly: 'pm2_5,us_aqi',
    forecast_days: '2',
    timezone: 'auto',
  });

  try {
    const data = await getJSON(`${AIR_URL}?${params}`);
    const current = data.current || {};
    if (current.pm2_5 === null || current.pm2_5 === undefined) {
      throw new Error('Incomplete air-quality response');
    }
    const pm25 = Number(current.pm2_5);
    if (!Number.isFinite(pm25)) throw new Error('Incomplete air-quality response');
    const aqi = Number(current.us_aqi) || pm25ToAqi(pm25);
    const times = data.hourly?.time || [];
    const values = data.hourly?.pm2_5 || [];
    let start = times.indexOf(current.time);
    if (start < 0) start = 0;

    const hourly = [];
    for (let i = start; i < Math.min(start + 24, times.length); i += 1) {
      const value = Number(values[i]);
      if (!Number.isFinite(value)) continue;
      hourly.push({
        time: String(times[i]).slice(11, 16),
        pm25: Math.round(value),
        aqi: pm25ToAqi(value),
      });
    }

    const result = {
      place,
      aqi,
      pm25: Math.round(pm25),
      pm10: Math.round(Number(current.pm10) || pm25 * 1.15),
      no2: Math.round(Number(current.nitrogen_dioxide) || 0),
      o3: Math.round(Number(current.ozone) || 0),
      co: Math.round(Number(current.carbon_monoxide) || 0),
      hourly,
      advisory: advisoryFor(aqi),
      dominant: dominantPollutant(current),
      bestWindow: findBestWindow(hourly),
      source: 'open-meteo',
      sourceKind: 'modeled',
      localTime: new Date(Date.now() + (Number(data.utc_offset_seconds) || 0) * 1000).toISOString().slice(11, 16),
      fetchedAt: new Date().toISOString(),
    };
    if (!Number.isFinite(result.pm25)) throw new Error('Incomplete air-quality response');
    return cacheSet(airCache, key, result);
  } catch (error) {
    return fallbackAir(place);
  }
}

/** Reverse of the simplified US EPA PM2.5 breakpoints, used for manual AQI entries. */
export function aqiToPm25(aqi) {
  const value = Math.min(500, Math.max(0, Number(aqi) || 0));
  const breakpoints = [
    [0, 50, 0, 12.0], [51, 100, 12.1, 35.4], [101, 150, 35.5, 55.4],
    [151, 200, 55.5, 125.4], [201, 300, 125.5, 225.4], [301, 400, 225.5, 325.4],
    [401, 500, 325.5, 500.4],
  ];
  for (const [al, ah, cl, ch] of breakpoints) {
    if (value <= ah) return Math.round(cl + ((ch - cl) / (ah - al)) * (value - al));
  }
  return 500;
}

function fixedAir({ aqi, name, country, source, sourceKind, note }) {
  const value = Math.min(500, Math.max(0, Math.round(Number(aqi) || 0)));
  const pm25 = aqiToPm25(value);
  const now = new Date();
  return {
    place: { name, country, latitude: null, longitude: null },
    aqi: value,
    pm25,
    pm10: Math.round(pm25 * 1.2),
    no2: 0, o3: 0, co: 0,
    hourly: [],
    advisory: advisoryFor(value),
    dominant: { name: value > 50 ? 'PM2.5' : '—', note: 'reported value', ratio: 0 },
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
  if (air.source === 'offline-estimate') return 'Modeled estimate (offline fallback)';
  return 'Modeled estimate · Open-Meteo (CAMS)';
}
