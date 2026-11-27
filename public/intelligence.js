import { aqiCategory, AQI_BANDS } from '/shared/standards.js';

const components = {
  pm25: ['PM2.5', 'Fine particles', 'Particles up to about 2.5 micrometres across, including fine smoke particles.', 'pm-pollution/particulate-matter-pm-basics'],
  pm10: ['PM10', 'Coarse and fine particles', 'Airborne particles up to about 10 micrometres across, including dust.', 'pm-pollution/particulate-matter-pm-basics'],
  no2: ['NO₂', 'Nitrogen dioxide', 'A gas associated with fuel combustion in traffic, power plants and equipment.', 'no2-pollution/basic-information-about-no2'],
  so2: ['SO₂', 'Sulfur dioxide', 'A gas released when sulfur-containing fuels are burned in power plants and industrial facilities.', 'so2-pollution/sulfur-dioxide-basics'],
  co: ['CO', 'Carbon monoxide', 'An odourless gas produced when fuel burns. Vehicle exhaust is one outdoor source.', 'co-pollution/basic-information-about-carbon-monoxide-co-outdoor-air-pollution'],
  o3: ['O₃', 'Ground-level ozone', 'A smog-forming gas that builds up when sunlight drives reactions between other pollutants.', 'ground-level-ozone-pollution/ground-level-ozone-basics'],
};
const unit = 'µg/m³';
const region = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[c]);
const valid = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const numberFormat = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1 });
const showNumber = n => valid(n) ? numberFormat.format(n) : '—';
const indexFor = standard => standard === 'cpcb' ? 'in' : 'us';
const scaleName = standard => standard === 'cpcb' ? 'Indian AQI' : 'US AQI';
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const dateFormats = new Map();
function dateLabel(time, timezone = 'UTC', mode = 'full') {
  if (time == null || !Number.isFinite(new Date(time).getTime())) return 'Unknown time';
  const key = `${timezone}/${mode}`;
  if (!dateFormats.has(key)) {
    const options = { timeZone: timezone };
    if (mode !== 'hour') Object.assign(options, { month:'short', day:'numeric' });
    if (mode !== 'day') Object.assign(options, { hour:'2-digit', minute:'2-digit', hourCycle:'h23' });
    dateFormats.set(key, new Intl.DateTimeFormat('en-IN', options));
  }
  return dateFormats.get(key).format(new Date(time));
}
function valueAt(point, metric, standard = state.standard) {
  const value = metric === 'aqi' ? point?.[indexFor(standard)] : point?.pollutants?.[metric];
  return valid(value) ? value : null;
}
function hourlyRow(point, metric) {
  const value=valueAt(point,metric);
  const lowerBound=state.standard==='cpcb' && metric==='aqi' && value===null && point.inLowerBound===401 ? 401 : null;
  return {time:point.time,value,lowerBound};
}
// Keep an absent provider hour as a visible gap, including across time-zone changes.
function timeline(points,metric) {
  const rows=[];
  for(const point of points){
    const time=Date.parse(point.time),last=rows.at(-1);
    if(!Number.isFinite(time))continue;
    if(last){
      for(let t=Date.parse(last.time)+3600000;t<time;t+=3600000){
        rows.push({time:new Date(t).toISOString(),value:null,lowerBound:null});
      }
    }
    rows.push(hourlyRow(point,metric));
  }
  return rows;
}
function summary(values) {
  const usable = values.filter(valid);
  return { count: usable.length, average: mean(usable), min: usable.length ? Math.min(...usable) : null,
    max: usable.length ? Math.max(...usable) : null };
}
function category(value) {
  return valid(value) ? aqiCategory(state.standard, Math.round(value)) : null;
}
const state = { data:null, standard:'us', city:'', loading:false, days:1, metric:'aqi',
  history:null, historyPending:false, historyError:'', historyVersion:0,
  other:null, otherHistory:null, otherError:'', otherVersion:0, searchVersion:0, otherPending:false };
let initialized = false;
const memory = new Map();
const fetching = new Map();

function heading(title, small = '') {
  return `<div class="cd-section-title"><h2>${escape(title)}</h2>${small ? `<span>${escape(small)}</span>` : ''}</div>`;
}
function waiting(message) {
  return `<div class="cd-loading" role="status"><span class="cd-skeleton" aria-hidden="true"></span>${escape(message)}</div>`;
}
function empty(message) {
  return `<p class="cd-empty">${escape(message)}</p>`;
}
function modelCredit() {
  return '<a href="https://open-meteo.com/en/docs/air-quality-api" target="_blank" rel="noopener noreferrer">Open-Meteo / CAMS</a>';
}
function seriesLine(values, getX, getY) {
  const paths = [];
  let segment = [];
  const finish = () => { if (segment.length) paths.push(segment); segment = []; };
  values.forEach((value, index) => {
    if (!valid(value)) { finish(); return; }
    segment.push([getX(index), getY(value), index]);
  });
  finish();
  return paths;
}
function sparkline(values) {
  const {count, min, max} = summary(values);
  if (count < 3) return '';
  const segments = seriesLine(values, i => 2 + i / (values.length - 1) * 76,
    v => 22 - (v - min) / (max - min || 1) * 19);
  const paths = segments.map(points => `<polyline points="${points.map(([x,y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')}" />`).join('');
  return `<svg class="cd-spark" viewBox="0 0 80 26" aria-hidden="true">${paths}</svg>`;
}
function renderPollutants() {
  const {data, loading, history, standard} = state;
  const host = region('pollutants');
  const title = heading('Pollutant breakdown', 'Concentrations · µg/m³');
  if (loading) {host.innerHTML = title + waiting('Loading pollutant concentrations…'); return;}
  const current = data?.current;
  const previous = data?.previousDay;
  const indices = current?.[indexFor(standard) + 'Subindices'];
  const hasTrend = history?.points?.length > 0;
  host.innerHTML = title + `<div class="cd-poll-grid">${Object.entries(components).map(([key, [label, name, definition, source]]) => {
    const reading = valueAt(current, key);
    const baseline = valueAt(previous, key);
    const change = valid(reading) && valid(baseline) ? Math.round((reading-baseline)*10)/10 : null;
    const trend = hasTrend ? history.points.slice(-24).map(p => valueAt(p, key)) : [];
    const band = category(indices?.[key]);
    const delta = change === null ? '' : change === 0 ? 'Unchanged from 24h ago' : `${showNumber(Math.abs(change))} ${change > 0 ? 'higher' : 'lower'} than 24h ago`;
    return `<article class="cd-poll"><div class="cd-poll-top"><h3>${label}</h3>${sparkline(trend)}</div>
      <details class="cd-poll-name"><summary>${name}</summary><p>${definition} <a href="https://www.epa.gov/${source}" rel="noopener noreferrer" target="_blank">EPA</a></p></details>
      <p class="cd-measure">${showNumber(reading)}${valid(reading) ? `<small> ${unit}</small>` : ''}</p>
      ${band ? `<p class="cd-subindex">${escape(band.label)} <span>· subindex ${Math.round(indices[key])}</span></p>` : ''}
      ${delta ? `<p class="cd-micro">${escape(delta)}</p>` : !valid(reading) && data ? '<p class="cd-micro">Reading unavailable</p>' : ''}
      ${data?`<a class="cd-trend-link" href="#analytics" data-trend="${key}" aria-label="Explore ${label} history">View trend</a>`:''}</article>`;
  }).join('')}</div>` + (current ? `<p class="cd-foot">${data.stale ? 'Cached model data' : 'Modeled concentrations'} · ${escape(dateLabel(current.time,data.timezone))} ${escape(data.timezone)}${hasTrend ? ' · Mini charts show the previous 24 modeled hours.' : ''}</p>` : '<p class="cd-foot">Select a city to see modeled concentrations.</p>');
  for(const link of host.querySelectorAll('[data-trend]'))link.addEventListener('click',()=>{
    state.metric=link.dataset.trend;
    region('cdMetric').value=state.metric;
    renderHistory();renderComparison();
  });
}

function chart(container, rows, options) {
  const {timezone, metric, forecast = false, daily = false} = options;
  const values = rows.map(p => p.value);
  const stats = summary(values);
  const limited=rows.filter(p=>valid(p.lowerBound));
  if (!stats.count && !limited.length) {
    container.innerHTML = empty(`No ${metric === 'aqi' ? scaleName(state.standard) : components[metric][0]} series is available for this period.`);
    return;
  }
  const valueLabel = metric === 'aqi' ? scaleName(state.standard) : components[metric][0] + ' (' + unit + ')';
  const width=640, height=116, padding=5;
  const max = Math.max(1, stats.max || 0, ...limited.map(p=>p.lowerBound)), step = 10 ** Math.floor(Math.log10(max));
  const top = Math.ceil(max / (step/2)) * (step/2);
  const x = i => padding + i / Math.max(1, rows.length - 1) * (width-padding*2);
  const y = v => height - padding - v/top*(height-padding*2);
  const segments = seriesLine(values, x, y);
  const drawings = segments.map(points => {
    const line = points.map(([a,b]) => `${a.toFixed(2)},${b.toFixed(2)}`).join(' ');
    const first = points[0][0].toFixed(2), last = points.at(-1)[0].toFixed(2);
    return `<polygon points="${first},${height-padding} ${line} ${last},${height-padding}" class="cd-chart-fill" />
      <polyline points="${line}" class="cd-chart-line" />` +
      (forecast || points.length === 1 ? points.map(([a,b,i]) => `<circle cx="${a}" cy="${b}" r="3.5" fill="${escape(category(values[i])?.color || 'currentColor')}" class="cd-chart-point"/>`).join('') : '');
  }).join('');
  const timeMode = daily ? 'day' : 'hour';
  const lastIndex = rows.length-1;
  const ticks = [...new Set([0,Math.round(lastIndex/3),Math.round(lastIndex*2/3),lastIndex])];
  container.innerHTML = `<figure class="cd-figure" aria-label="${escape(valueLabel)} ${forecast ? 'forecast' : 'trend'}">
    <figcaption><span>${escape(valueLabel)}</span><output class="cd-chart-readout"></output></figcaption>
    <div class="cd-plot"><div class="cd-yaxis" aria-hidden="true"><span>${showNumber(top)}</span><span>${showNumber(top/2)}</span><span>0</span></div>
      <div class="cd-stage"><svg class="cd-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
      ${[padding,height/2,height-padding].map(h=>`<line x1="0" y1="${h}" x2="${width}" y2="${h}" class="cd-chart-grid"/>`).join('')}
      ${drawings}${rows.map((p,i)=>valid(p.lowerBound)?`<path d="M${x(i)-4} ${y(p.lowerBound)+4} l4 -7 l4 7 z" stroke="currentColor" fill="${escape(category(p.lowerBound)?.color)}"/>`:'').join('')}
      <line class="cd-cross" y1="${padding}" y2="${height-padding}"/><circle class="cd-cursor" r="4"/></svg>
      <div class="cd-axis">${ticks.map(i=>`<span>${forecast&&i===0?`<strong title="Current model hour">Start</strong> · `:''}${escape(dateLabel(rows[i].time,timezone,timeMode))}</span>`).join('')}</div></div>
    </div>
    <input class="cd-scrubber" type="range" min="0" max="${lastIndex}" value="0" step="1" aria-label="${forecast ? 'Explore forecast hours' : 'Explore historical values'}" />
  </figure>`;
  const slider = container.querySelector('input'), svg = container.querySelector('.cd-chart');
  const cross=svg.querySelector('.cd-cross'), cursor=svg.querySelector('.cd-cursor');
  const readout=container.querySelector('output');
  function select(index) {
    const row=rows[index], val=values[index], band=metric==='aqi' && !daily ? category(val) : null;
    const time = dateLabel(row.time,timezone,daily?'day':'full');
    const text=valid(val)?showNumber(val):valid(row.lowerBound)?'401+ · Severe':'Unavailable';
    const label=`${forecast && index===0?'Current model hour · ':''}${time} · ${text}${band ? ' · '+band.label : ''}`;
    readout.textContent = label;
    slider.value=String(index);slider.setAttribute('aria-valuetext',label);
    cross.setAttribute('x1',x(index));cross.setAttribute('x2',x(index));
    cursor.setAttribute('visibility',valid(val)?'visible':'hidden');
    if(valid(val)){cursor.setAttribute('cx',x(index));cursor.setAttribute('cy',y(val));}
  }
  slider.addEventListener('input',()=>select(Number(slider.value)));
  function fromPointer(e) {
    const box=svg.getBoundingClientRect();
    if (!box.width) return;
    select(Math.max(0,Math.min(lastIndex,Math.round(((e.clientX-box.left)/box.width*width-padding)/(width-padding*2)*lastIndex))));
  }
  svg.addEventListener('pointermove',fromPointer);
  svg.addEventListener('pointerdown',fromPointer);
  select(forecast ? 0 : lastIndex);
}
function stat(label,value,when='') {
  return `<div><span>${escape(label)}</span><strong>${escape(value)}</strong>${when ? `<small>${escape(when)}</small>` : ''}</div>`;
}
function renderForecast() {
  const {data,loading,standard} = state;
  const host=region('forecast');
  const title=heading('Hourly outlook',scaleName(standard));
  if (loading) {host.innerHTML=title+waiting('Loading the hourly forecast…');return;}
  const rows=timeline(data?.forecast || [],'aqi');
  const stats=summary(rows.map(p=>p.value));
  const limited=rows.filter(p=>valid(p.lowerBound));
  if(!stats.count && !limited.length){host.innerHTML=title+empty(data?'The provider has insufficient data for this forecast and standard.':'Choose a city or use your location to see its hourly forecast.');return;}
  const low=rows.find(p=>p.value===stats.min),high=rows.find(p=>p.value===stats.max);
  const now=valueAt(data.current,'aqi'), prior=valueAt(data.previousDay,'aqi');
  const difference=valid(now)&&valid(prior)?Math.round(now-prior):null;
  host.innerHTML=title+`<div class="cd-statrow">${stat('Forecast low',stats.count?showNumber(stats.min):'401+',dateLabel((stats.count?low:limited[0]).time,data.timezone))}
    ${stat('Forecast peak',limited.length?'401+':showNumber(stats.max),dateLabel((limited[0] || high).time,data.timezone))}
    ${difference!==null ? stat('Change over 24h',difference===0?'No change':(difference>0?'+':'−')+showNumber(Math.abs(difference)),'Compared with the same hour') : ''}</div>
    <div class="cd-forecast-chart"></div><p class="cd-foot">${data.stale?'Cached forecast · ':''}${stats.count+limited.length} of 24 modeled hours available · ${escape(data.timezone)}. ${limited.length?'Triangle markers show a lower bound of 401. ':''}Forecasts can change. ${modelCredit()}</p>`;
  chart(host.querySelector('.cd-forecast-chart'),rows,{timezone:data.timezone,metric:'aqi',forecast:true});
}

async function getJSON(url) {
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),26000);
  try {
    const response=await fetch(url,{signal:controller.signal});
    if(response.status===429)throw Error('Too many requests. Wait a moment and retry.');
    if(!response.ok)throw Error('The data service is unavailable. Please retry.');
    return await response.json();
  }catch(error){
    if(error.name==='AbortError')throw Error('The data service took too long. Please retry.');
    throw error;
  }finally{clearTimeout(timer);}
}
function readHistory(latitude,longitude,days,force=false) {
  const params=new URLSearchParams({lat:latitude,lon:longitude,days});
  const key=params.toString();
  const hit=memory.get(key);
  if(!force && hit && Date.now()-hit.saved<15*60_000)return Promise.resolve(hit.data);
  if(fetching.has(key))return fetching.get(key);
  const request=getJSON('/api/history?'+key).then(data=>{
    if(!Array.isArray(data.points))throw Error('The provider returned an incomplete history.');
    memory.set(key,{saved:Date.now(),data});
    if(memory.size>12)memory.delete(memory.keys().next().value);
    return data;
  }).catch(error=>{
    if(hit && Date.now()-hit.saved<24*3600_000)return {...hit.data,stale:true};
    throw error;
  }).finally(()=>fetching.delete(key));
  fetching.set(key,request);
  return request;
}
function setupAnalytics() {
  const host=region('analytics');
  host.innerHTML= heading('Historical analytics') + `
    <div class="cd-tools"><div class="cd-periods" role="group" aria-label="History period">
      <button type="button" data-days="1" aria-pressed="true">24 hours</button><button type="button" data-days="7" aria-pressed="false">7 days</button>
      <button type="button" data-days="30" aria-pressed="false">30 days</button></div>
      <label class="cd-field">Metric <select id="cdMetric"><option value="aqi">Air quality index</option>
      ${Object.entries(components).map(([k,[label]])=>`<option value="${k}">${label}</option>`).join('')}</select></label></div>
    <div id="cdHistory"></div>
    <div class="cd-compare"><h3>Compare cities</h3><form id="cdCompareForm" class="cd-compare-form">
      <label class="cd-field" for="cdOtherCity">Comparison city<input id="cdOtherCity" type="search" placeholder="Enter a city" minlength="2" maxlength="100" required /></label>
      <button type="submit" class="cd-action">Find city</button></form><div id="cdMatches" aria-live="polite"></div>
      <div id="cdComparison" aria-live="polite"></div></div>`;
  for(const b of host.querySelectorAll('[data-days]'))b.addEventListener('click',()=>{
    const days=Number(b.dataset.days);
    if(days===state.days)return;
    state.days=days;
    for(const option of host.querySelectorAll('[data-days]'))option.setAttribute('aria-pressed',String(option===b));
    loadHistory();
  });
  region('cdMetric').addEventListener('change',e=>{state.metric=e.target.value;renderHistory();renderComparison();});
  region('cdCompareForm').addEventListener('submit',findComparison);
  region('cdOtherCity').addEventListener('input',()=>{state.searchVersion++;region('cdMatches').replaceChildren();});
}
function dailyPoints(points) {
  const groups=new Map();
  for(const p of points){
    const day=dateLabel(p.time,state.history.timezone,'day');
    if(!groups.has(day))groups.set(day,{time:p.time,values:[]});
    groups.get(day).values.push(p.value);
  }
  return Array.from(groups.values(), g=>{
    const usable=g.values.filter(valid);
    return {time:g.time,value:mean(usable),count:usable.length};
  });
}
function weekdayInsight(days,timezone,metric) {
  const groups=new Map();
  const weekday=new Intl.DateTimeFormat('en-IN',{timeZone:timezone,weekday:'long'});
  for(const day of days){
    if(day.count<18)continue;
    const key=weekday.format(new Date(day.time));
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(day.value);
  }
  if(groups.size<7 || [...groups.values()].some(values=>values.length<3))return '';
  const ranked=Array.from(groups,([day,values])=>({day,count:values.length,average:mean(values)}))
    .sort((a,b)=>b.average-a.average);
  if(showNumber(ranked[0].average)===showNumber(ranked[1].average))return '';
  const top=ranked[0], metricName=metric==='aqi'?scaleName(state.standard):components[metric][0];
  return `<p class="cd-insight">${top.day}s had the highest mean ${escape(metricName)} during these 30 days (${showNumber(top.average)}${metric==='aqi'?'':' '+unit}, across ${top.count} ${top.day}s).</p>`;
}
function drawDistribution(points) {
  const bands=AQI_BANDS[state.standard], counts=bands.map(()=>0);
  let available=0;
  for(const p of points){
    const row=hourlyRow(p,'aqi'), band=category(row.value ?? row.lowerBound);
    if(!band)continue;
    const i=bands.findIndex(b=>b.label===band.label);
    if(i<0)continue;
    counts[i]++;available++;
  }
  if(!available)return '';
  let start=0;
  const bars=bands.map((b,i)=>{
    const width=counts[i]/available*100, offset=start; start+=width;
    return `<rect x="${offset}%" y="0" width="${width}%" height="8" fill="${escape(b.color)}" />`;
  }).join('');
  return `<div class="cd-distribution"><h3>Hours by AQI category</h3><svg aria-hidden="true" width="100%" height="8">${bars}</svg>
    <ul>${bands.map((b,i)=>`<li><svg width="10" height="10" aria-hidden="true"><circle cx="5" cy="5" r="4" fill="${escape(b.color)}"/></svg> ${escape(b.label)} <strong>${counts[i]}h</strong></li>`).join('')}</ul></div>`;
}
function recentComparison(points) {
  if(points.length<48)return '';
  const vals=points.map(p=>valueAt(p,state.metric)),recent=summary(vals.slice(-24)),previous=summary(vals.slice(0,-24));
  if(recent.count<18 || previous.count < Math.ceil((points.length-24)*.75))return '';
  const diff=Math.round((recent.average-previous.average)*10)/10;
  const metricName=state.metric==='aqi'?scaleName(state.standard):components[state.metric][0];
  return `<p class="cd-insight">The latest 24-hour mean ${escape(metricName)} was ${showNumber(recent.average)}${state.metric==='aqi'?'':' '+unit}, ${diff===0?'matching the earlier average':`${showNumber(Math.abs(diff))} ${diff>0?'higher':'lower'} than the earlier average`} in this period.</p>`;
}
function renderHistory() {
  const {data,history,historyPending,historyError,days,metric,city}=state, host=region('cdHistory');
  region('cdOtherCity').disabled=!data;
  region('cdCompareForm').querySelector('button').disabled=!data;
  if(historyPending){host.innerHTML=waiting('Loading historical estimates…');return;}
  if(historyError){host.innerHTML=`<p role="status" class="cd-empty">${escape(historyError)}</p><button type="button" class="cd-action">Retry history</button>`;
    host.querySelector('button').addEventListener('click',()=>loadHistory(true));return;}
  if(!history){host.innerHTML=empty(data?'Open Analytics to load historical estimates.':'Choose a city or use your location to explore its air-quality history.');return;}
  const rows=timeline(history.points,metric), stats=summary(rows.map(p=>p.value));
  const limited=rows.filter(p=>valid(p.lowerBound)).length;
  const name=metric==='aqi'?scaleName(state.standard):components[metric][0]+' ('+unit+')';
  const shownRows=days===1?rows:dailyPoints(rows);
  host.innerHTML=`<div class="cd-history-label"><h3>${escape(city)}</h3><span>${escape(name)}</span></div>
    <div class="cd-statrow">${stat('Average',showNumber(stats.average))}${stat('Maximum',limited?'401+':showNumber(stats.max))}${stat('Minimum',stats.count?showNumber(stats.min):limited?'401+':'—')}</div>
    <div class="cd-history-chart"></div>${recentComparison(history.points)}${days===30?weekdayInsight(shownRows,history.timezone,metric):''}
    ${drawDistribution(history.points)}
    <p class="cd-foot">${history.stale?'Cached history · ':''}${stats.count} of ${days*24} hours have exact values · ${escape(history.timezone)}. ${limited?`${limited} hours reported 401+ and are excluded from averages. `:''}${days!==1?'The line shows local daily means. ':''}Archived model estimates from ${modelCredit()}.</p>`;
  chart(host.querySelector('.cd-history-chart'),shownRows,{timezone:history.timezone,metric,daily:days!==1});
}
async function loadHistory(force=false) {
  const {data,days}=state;
  const version=++state.historyVersion;
  state.history=null;state.historyError='';state.historyPending=Boolean(data);
  if(state.other)loadOther(force);
  renderHistory();renderComparison();
  if(!data)return;
  try{
    const results=await readHistory(data.latitude,data.longitude,days,force);
    if(version===state.historyVersion)state.history=results;
  }catch(error){if(version===state.historyVersion)state.historyError=error.message;}
  finally{if(version===state.historyVersion){state.historyPending=false;renderHistory();renderPollutants();renderComparison();}}
}
async function findComparison(event) {
  event.preventDefault();
  const input=region('cdOtherCity'),list=region('cdMatches'),q=input.value.trim(),version=++state.searchVersion;
  if(!state.data || q.length<2)return;
  list.innerHTML=waiting('Finding cities…');
  try{
    const result=await getJSON('/api/geocode?q='+encodeURIComponent(q));
    if(version!==state.searchVersion)return;
    if(!result.results?.length){list.innerHTML=empty('No matches. Try another spelling.');return;}
    list.innerHTML=`<ul class="cd-city-list">${result.results.map((p,i)=>`<li><button type="button" data-place="${i}">${escape([p.name,p.region,p.country].filter(Boolean).join(', '))}</button></li>`).join('')}</ul>`;
    list.querySelectorAll('button').forEach(button=>button.addEventListener('click',()=>{
      state.other=result.results[Number(button.dataset.place)];
      input.value=[state.other.name,state.other.region,state.other.country].filter(Boolean).join(', ');
      list.replaceChildren();loadOther();
    }));
  }catch(error){if(version===state.searchVersion)list.innerHTML=empty(error.message);}
}
async function loadOther(force=false) {
  const version=++state.otherVersion,place=state.other;
  state.otherHistory=null;state.otherError='';state.otherPending=Boolean(place);renderComparison();
  if(!place)return;
  try{
    const history=await readHistory(place.latitude,place.longitude,state.days,force);
    if(version===state.otherVersion)state.otherHistory=history;
  }catch(error){if(version===state.otherVersion)state.otherError=error.message;}
  finally{if(version===state.otherVersion){state.otherPending=false;renderComparison();}}
}
function renderComparison() {
  const {otherHistory,other,history,metric,otherPending,otherError}=state, host=region('cdComparison');
  if(otherPending){host.innerHTML=waiting('Loading the comparison city…');return;}
  if(otherError){host.innerHTML=empty(otherError)+'<button type="button" class="cd-action">Retry comparison</button>';
    host.querySelector('button').addEventListener('click',()=>loadOther(true));return;}
  if(!otherHistory || !history){host.replaceChildren();return;}
  // Local hour grids may be offset by 30 or 45 minutes. Compare the same UTC
  // interval at both sites without interpolating a missing concentration.
  const a=history.points,b=otherHistory.points;
  const start=Math.max(Date.parse(a[0]?.time),Date.parse(b[0]?.time));
  const end=Math.min(Date.parse(a.at(-1)?.time),Date.parse(b.at(-1)?.time));
  const overlap=points=>points.filter(p=>Date.parse(p.time)>=start && Date.parse(p.time)<=end)
    .map(p=>valueAt(p,metric)).filter(valid);
  const first=overlap(a),second=overlap(b);
  if(!first.length || !second.length){host.innerHTML=empty('These cities have no overlapping data for the selected metric.');return;}
  const metricName=metric==='aqi'?scaleName(state.standard):components[metric][0]+' ('+unit+')';
  host.innerHTML=`<div class="cd-statrow">${stat(state.city,showNumber(mean(first)),metricName)}${stat(other.name,showNumber(mean(second)),metricName)}</div>
    <p class="cd-foot">${history.stale||otherHistory.stale?'Includes cached data. ':''}Mean of ${first.length} and ${second.length} available hourly values over the same period, ${escape(dateLabel(start,'UTC'))} to ${escape(dateLabel(end,'UTC'))} UTC.</p>`;
}
export function showAnalytics() {
  if(initialized && state.data && !state.historyPending && !state.history && !state.historyError)loadHistory();
}
export function initIntelligence() {
  if(initialized)return;
  initialized=true;setupAnalytics();renderPollutants();renderForecast();renderHistory();renderComparison();
  addEventListener('hashchange',()=>{if(location.hash==='#analytics')showAnalytics();});
}
export function updateIntelligence({data=null,place=null,standard='us',loading=false}={}) {
  if(!initialized)initIntelligence();
  const previous=state.data;
  state.standard=(standard==='in'||standard==='cpcb')?'cpcb':'us';
  state.loading=loading;
  state.data=data;state.city=place?.name || '';
  const changed=previous?.latitude!==data?.latitude || previous?.longitude!==data?.longitude || previous?.asOf!==data?.asOf;
  if(changed || !data){
    state.historyVersion++;state.otherVersion++;state.searchVersion++;
    Object.assign(state,{history:null,historyError:'',historyPending:false,other:null,otherHistory:null,otherError:'',otherPending:false});
    region('cdOtherCity').value='';region('cdMatches').replaceChildren();
  }
  renderPollutants();renderForecast();renderHistory();renderComparison();
  if(location.hash==='#analytics')showAnalytics();
}

