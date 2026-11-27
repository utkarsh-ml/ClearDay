// CPCB National Air Quality Index, tables 3.11–3.12.
// https://airquality.cpcb.gov.in/ccr_docs/FINAL-REPORT_AQI_.pdf
function bands(rows) {
  return rows.map(([max, label, color], i) => ({
    min: i === 0 ? 0 : rows[i - 1][0] + 1, max, label, color,
  }));
}
export const AQI_BANDS = {
  us: bands([[50,'Good','#00e400'],[100,'Moderate','#ffff00'],[150,'Unhealthy for sensitive groups','#ff7e00'],[200,'Unhealthy','#ff0000'],[300,'Very unhealthy','#8f3f97'],[500,'Hazardous','#7e0023']]),
  cpcb: bands([[50,'Good','#00b050'],[100,'Satisfactory','#92d050'],[200,'Moderate','#ffff00'],[300,'Poor','#ff9900'],[400,'Very poor','#ff0000'],[500,'Severe','#c00000']]),
};
export function aqiCategory(standard, value) {
  if (!Number.isFinite(value) || value < 0 || !AQI_BANDS[standard]) return null;
  const scale = AQI_BANDS[standard];
  return scale.find(band => value <= band.max) || scale[scale.length - 1];
}

const limits = {
  pm2_5: [30,60,90,120,250],
  pm10: [50,100,250,350,430],
  nitrogen_dioxide: [40,80,180,280,400],
  sulphur_dioxide: [40,80,380,800,1600],
  ammonia: [200,400,800,1200,1800],
  lead: [0.5,1,2,3,3.5],
  carbon_monoxide: [1,2,10,17,34],
  ozone: [50,100,168,208,748],
};
const seconds = t => typeof t === 'number' ? t : Date.parse(t) / 1000;
function meanInWindow(hours, field, end, length, required) {
  if (!hours[field]) return null;
  const now = seconds(hours.time[end]);
  let sum = 0, count = 0;
  for (let i = end; i >= 0 && i > end - length; i--) {
    const age = now - seconds(hours.time[i]);
    if (age >= length * 3600) break;
    const value = hours[field][i];
    if (Number.isFinite(value) && value >= 0) { sum += value; count++; }
  }
  return count >= required ? sum / count : null;
}
function subIndex(concentration, field) {
  const hi = limits[field];
  const quantum = ['carbon_monoxide','lead'].includes(field) ? 0.1 : 1;
  const value = Math.round(concentration / quantum) * quantum;
  const i = hi.findIndex(limit => value <= limit + 1e-8);
  if (i < 0) return {severe:true};
  const band = AQI_BANDS.cpcb[i];
  const low = i === 0 ? 0 : hi[i - 1] + quantum;
  return {value: Math.round(band.min + (value - low) * (band.max - band.min) / (hi[i] - low))};
}
export function calculateCpcb(hourly, index) {
  const subIndices = {};
  let dominant = null, highest = -1, available = 0, particulate = false;
  let severe = false;
  for (const field of Object.keys(limits)) {
    subIndices[field] = null;
    if (!hourly?.time || index < 0 || index >= hourly.time.length) continue;
    const shortWindow = field === 'ozone' || field === 'carbon_monoxide';
    let value = meanInWindow(hourly, field, index, shortWindow ? 8 : 24, shortWindow ? 8 : 16);
    if (field === 'ozone') {
      const single = hourly.ozone?.[index];
      // At 209 µg/m³ and above the CPCB table uses a one-hour ozone value.
      if (Number.isFinite(single) && Math.round(single) >= 209) value = single;
      else if (value !== null && Math.round(value) >= 209) value = null;
    }
    if (value === null) continue;
    const result = subIndex(field === 'carbon_monoxide' ? value / 1000 : value, field);
    available++;
    if (field === 'pm2_5' || field === 'pm10') particulate = true;
    if (result.severe) {
      if (!severe) dominant = field;
      else dominant = null; // Multiple open-ended subindices cannot be ranked.
      severe = true;
    } else {
      subIndices[field] = result.value;
      if (!severe && result.value > highest) { highest = result.value; dominant = field; }
    }
  }
  if (available < 3 || !particulate) return {value:null,category:null,color:null,dominant:null,subIndices,lowerBound:null,reason:'CPCB needs at least three eligible pollutants, including PM2.5 or PM10.'};
  const value = severe ? null : highest;
  const category = aqiCategory('cpcb', severe ? 401 : value);
  return {value,category:category.label,color:category.color,dominant,subIndices,lowerBound:severe ? 401 : null,
    reason: severe ? 'The concentration exceeds the last published numeric breakpoint.' : null};
}
