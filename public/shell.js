import { AQI_BANDS, aqiCategory } from '/shared/standards.js';
import { updateIntelligence, showAnalytics } from './intelligence.js';
const $ = s => document.querySelector(s);
const pages = {
  overview: ['Air overview','Local air conditions and your plan for the day.'],
  air: ['Air quality','Explore individual pollutants and the next 24 hours.'],
  plan: ['My daily plan','Practical changes for your household, from morning to evening.'],
  analytics: ['Air analytics','Track changes over time and compare air across cities.'],
  community: ['Community','Prepare a clean-air plan for your school or neighbourhood.'],
  guide: ['ClearDay AI','Ask about the reading, the forecast or a change to your routine.'],
  preferences: ['Settings','Choose which household and travel details shape your plan.'],
};
const names = {pm25:'PM2.5',pm10:'PM10',no2:'NO₂',so2:'SO₂',co:'CO',o3:'O₃',nh3:'NH₃',pb:'Lead'};
const indiaAdvice = [
  'The CPCB category indicates minimal health impact.',
  'People who are sensitive to air pollution may notice mild discomfort.',
  'Children, older adults and people with heart or lung conditions may experience discomfort.',
  'Longer exposure may cause breathing discomfort. Check local guidance for outdoor activities.',
  'Prolonged exposure may affect breathing, especially for people with heart or lung conditions.',
  'Even light outdoor activity may cause breathing discomfort. Follow local health advisories.',
];
export function saved(key, fallback) { try {return localStorage.getItem(key) || fallback;} catch {return fallback;} }
export function remember(key, value) {try {localStorage.setItem(key,value);} catch {}}
export function route() {
  const key = location.hash.slice(1);
  const view = Object.hasOwn(pages,key) ? key : (key === 'calculator' ? 'plan' : 'overview');
  $('#pageTitle').textContent = pages[view][0];
  $('#pageIntro').textContent = pages[view][1];
  document.querySelectorAll('[data-view]').forEach(el => {el.hidden = !el.dataset.view.split(' ').includes(view);});
  document.querySelectorAll('[data-link]').forEach(el => {
    if (el.dataset.link === view) el.setAttribute('aria-current','page');
    else el.removeAttribute('aria-current');
  });
  const more = $('#moreBtn');
  if (['air','community','preferences'].includes(view)) more.setAttribute('aria-current','page'); else more.removeAttribute('aria-current');
  if ($('#moreDialog').open) $('#moreDialog').close();
  if (view === 'analytics') showAnalytics();
}
function applyTheme(theme) {
  document.documentElement.dataset.theme=theme;
  $('#themeToggle').setAttribute('aria-label',theme==='dark'?'Switch to light mode':'Switch to dark mode');
  $('#themeToggle use').setAttribute('href',theme==='dark'?'/icons.svg#sun':'/icons.svg#theme');
}
export function initShell() {
  applyTheme(saved('clearday.theme',matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'));
  $('#themeToggle').onclick=()=>{
    const theme=document.documentElement.dataset.theme==='dark'?'light':'dark';
    applyTheme(theme);remember('clearday.theme',theme);
  };
  $('#railToggle').onclick=()=>{
    const compact=document.documentElement.classList.toggle('rail-small');
    $('#railToggle').setAttribute('aria-expanded',String(!compact));
    $('#railToggle').setAttribute('aria-label',compact?'Expand sidebar':'Collapse sidebar');
  };
  $('#todayDate').textContent=new Intl.DateTimeFormat('en-IN',{weekday:'long',day:'numeric',month:'long',year:'numeric'}).format(new Date());
  document.querySelectorAll('[data-location]').forEach(el=>el.onclick=()=>{
    $('#locationDialog').showModal();
    if (!$('#searchPanel').hidden) $('#cityInput').focus();
  });
  document.querySelectorAll('[data-close]').forEach(el=>el.onclick=()=>el.closest('dialog').close());
  document.querySelectorAll('dialog').forEach(dialog=>dialog.addEventListener('click',e=>{if(e.target===dialog){
    const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();
  }}));
  $('#moreBtn').onclick=()=>$('#moreDialog').showModal();
  $('#moreDialog nav').onclick=()=>$('#moreDialog').close();
  $('#exploreGauge').onclick=()=>$('#scaleDialog').showModal();
  window.addEventListener('hashchange',()=>{route();window.scrollTo(0,0);$('#content').focus({preventScroll:true});});
  route();
}
function point(value,r=80) {
  const a=(145+250*Math.min(500,Math.max(0,value))/500)*Math.PI/180;
  return [100+r*Math.cos(a),91+r*Math.sin(a)];
}
function gauge(scale,value,lowerBound) {
  const bands=AQI_BANDS[scale];
  let last=0;
  const arcs=bands.map(b=>{
    const a=point(last+1), z=point(b.max-1);last=b.max;
    return '<path d="M'+a.join(' ')+' A80 80 0 0 1 '+z.join(' ')+'" fill="none" stroke="'+b.color+'" stroke-width="8"/>';
  }).join('');
  const marker=value ?? lowerBound;
  const [x,y]=point(marker ?? 0);
  $('#gaugeSvg').innerHTML=arcs+(marker===null?'':'<circle cx="'+x+'" cy="'+y+'" r="5.5" fill="#fff" stroke="#19382a" stroke-width="3"/>')+
    '<g fill="#3c5849" font-size="10" text-anchor="middle"><text x="32" y="150">0</text><text x="168" y="150">500</text></g>';
  $('#scaleLegend').replaceChildren(...bands.map(b=>{
    const row=document.createElement('div');row.className='legend-band';
    row.innerHTML='<svg aria-hidden="true" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="'+b.color+'" stroke="#777"/></svg><b>'+b.min+'–'+b.max+'</b>';
    row.append(' '+b.label);return row;
  }));
}
export function renderReading(plan,standard) {
  const air=plan?.air, data=air?.environment, current=data?.current;
  const india=standard==='in',scale=india?'cpcb':'us', label=india?'India AQI':'US AQI';
  const v=india?current?.in:(current?.us ?? air?.aqi);
  const value=Number.isFinite(v)?v:null;
  const lowerBound=india?(current?.inLowerBound ?? null):null;
  const band=aqiCategory(scale,value ?? lowerBound);
  const city=air ? [air.city,air.country].filter(Boolean).join(', ') : 'New Delhi, India';
  $('#airCity').textContent=city;$('#headerCity').textContent=city;
  $('#scaleName').textContent=label;$('#aqiNumber').textContent=value ?? (lowerBound!==null?lowerBound+'+':'—');
  $('#category').textContent=band?.label || (air?'Unavailable':'Checking air…');
  const oneCity=air?.source==='manual'||air?.source==='example';
  const advice=india?indiaAdvice[AQI_BANDS.cpcb.indexOf(band)]:air?.advisory?.general;
  $('#aqiMeaning').textContent= !air?'Getting the latest model estimate.':band ? (advice || '') :
    (oneCity?'This entry contains only a US AQI. Select US EPA to view it.':current?.inReason || 'The provider has insufficient data for this index.');
  $('#kindBadge').textContent=data?(data.stale?'Cached model':'Regional model'):air?.source==='manual'?'Manual reading':air?.source==='example'?'Example scenario':'Awaiting data';
  const dominant=india?current?.inDominant:current?.usDominant;
  $('#dominant').textContent=names[dominant] || '—';
  $('#dominantInfo').textContent=dominant?'Highest available pollutant sub-index.':'A pollutant breakdown requires model data.';
  $('#headlineAction').textContent=plan?.headlineAction?.what || (plan?.planUnavailable?plan.reason:'Your daily plan appears with a reading.');
  const time=data?.asOf || air?.fetchedAt;
  $('#timeLine').textContent=time?(data?'Model hour · ':'Entered · ')+new Intl.DateTimeFormat('en-IN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',timeZone:data?.timezone,timeZoneName:'short'}).format(new Date(time)):'Waiting for update';
  $('#sourceLine').replaceChildren();
  if(data){
    const link=document.createElement('a');link.href='https://open-meteo.com/en/docs/air-quality-api';link.rel='noreferrer';link.target='_blank';link.textContent='Open-Meteo · CAMS';$('#sourceLine').append(link);
  } else $('#sourceLine').textContent=air?.sourceText || 'Open-Meteo · CAMS';
  const note=data?.stale?'Showing the last available model run. Refresh to try again.':(air?.sourceNote || '');
  $('#sourceNote').textContent=note;$('#sourceNote').hidden=!note;
  $('#planBasis').textContent=Number.isFinite(air?.aqi)?'Plan based on US AQI '+air.aqi+' for '+city+'.':'';
  $('#scaleExplanation').textContent=label+' categories. Move the slider to compare a hypothetical reading.';
  gauge(scale,value,lowerBound);
  $('#compareAqi').value=String(value ?? lowerBound ?? 100);
  function compare() {
    const n=Number($('#compareAqi').value);
    const delta=value===null?null:n-value;
    $('#compareResult').textContent=label+' '+n+' · '+aqiCategory(scale,n).label+
      (delta===null?'':delta===0?' · matches this reading':' · '+Math.abs(delta)+' points '+(delta>0?'above':'below')+' this reading');
  }
  $('#compareAqi').oninput=compare;compare();
  updateIntelligence({place:air?{name:city}:null,standard,data:data || null});
}
