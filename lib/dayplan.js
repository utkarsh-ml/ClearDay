/**
 * ClearDay day-plan builder. Reuses the existing air-quality, exposure and
 * action engine in impact.js, adding time-of-day framing, exposure vs emission
 * labels, sourced guidance and no-cost metadata.
 */
import { normalizeProfile, computeBaseline, buildActions, rankActions, summarize } from './impact.js';
import { describeSource } from './aqi.js';
import { SOURCES, sourceLabel } from './sources.js';

const META = {
  'hepa-bedroom':    { time: 'evening', type: 'exposure', cost: 'purchase', source: 'ncdcIndoor' },
  'diy-filter':      { time: 'evening', type: 'exposure', cost: 'purchase', source: 'ncdcIndoor' },
  'clean-cooking':   { time: 'midday',  type: 'both',      cost: 'low',      source: 'whoAir' },
  'range-hood':      { time: 'midday',  type: 'exposure', cost: 'free',     source: 'ncdcIndoor' },
  'no-indoor-burning': { time: 'evening', type: 'exposure', cost: 'free',   source: 'ncdcIndoor' },
  'warm-layers':     { time: 'morning', type: 'both',      cost: 'low',     source: 'whoAir' },
  'vent-timing':     { time: 'midday',  type: 'exposure', cost: 'free',     source: 'ncdcIndoor' },
  'wet-mop':         { time: 'evening', type: 'exposure', cost: 'free',     source: 'ncdcIndoor' },
  'humidity':        { time: 'evening', type: 'exposure', cost: 'free',     source: 'ncdcIndoor' },
  'mask':            { time: 'morning', type: 'exposure', cost: 'purchase', source: 'cdcMask' },
  'exercise-timing': { time: 'morning', type: 'exposure', cost: 'free',     source: 'cpcbAqi' },
  'school-air-alert':{ time: 'morning', type: 'exposure', cost: 'free',     source: 'cpcbAqi' },
  'transit-swap':    { time: 'midday',  type: 'emissions', cost: 'free',    source: 'defra' },
  'no-idling':       { time: 'morning', type: 'emissions', cost: 'free',    source: 'defra' },
  'community-carpool': { time: 'evening', type: 'emissions', cost: 'free',  source: 'defra' },
  'no-burn-waste':   { time: 'midday',  type: 'emissions', cost: 'free',    source: 'whoAir' },
  'plant-meal':      { time: 'midday',  type: 'emissions', cost: 'free',    source: 'defra' },
  'school-route':    { time: 'morning', type: 'exposure', cost: 'free',     source: 'cpcbAqi' },
  'clean-room':      { time: 'evening', type: 'exposure', cost: 'free',     source: 'ncdcIndoor' },
  'recirculate':     { time: 'morning', type: 'exposure', cost: 'free',     source: 'cpcbAqi' },
  'one-trip-transit':{ time: 'midday',  type: 'emissions', cost: 'free',    source: 'defra' },
  'community-alert': { time: 'morning', type: 'exposure', cost: 'free',     source: 'cpcbAqi' },
  'no-burn-pledge':  { time: 'midday',  type: 'emissions', cost: 'free',    source: 'whoAir' },
  'carpool-rota':    { time: 'evening', type: 'emissions', cost: 'free',    source: 'defra' },
};

const TYPE_LABEL = { exposure: 'Reduces your exposure', emissions: 'Cuts emissions', both: 'Exposure + emissions' };

export function normalizeDayProfile(raw = {}) {
  const base = normalizeProfile(raw);
  const transport = ['walk', 'bike', 'transit', 'car'].includes(raw.transport) ? raw.transport : 'walk';
  const filtration = ['none', 'diy', 'hepa'].includes(raw.filtration) ? raw.filtration : (raw.purifier || 'none');
  const sensitivities = Array.isArray(raw.sensitivities) ? raw.sensitivities : [];
  const commuteDefaults = {
    walk: { carKm: 0, transitKm: 0, walkKm: 4, bikeKm: 0 },
    bike: { carKm: 0, transitKm: 0, walkKm: 0, bikeKm: 6 },
    transit: { carKm: 0, transitKm: 15, walkKm: 1, bikeKm: 0 },
    car: { carKm: 20, transitKm: 0, walkKm: 1, bikeKm: 0 },
  };
  const concerns = [...(base.concerns || [])];
  if (sensitivities.includes('asthma')) concerns.push('child-asthma');
  if (sensitivities.includes('elder') || base.elders > 0) concerns.push('elder');
  if (sensitivities.includes('pregnancy')) concerns.push('pregnancy');
  if (raw.mode === 'community') concerns.push('climate');
  return {
    ...base,
    mode: raw.mode === 'community' ? 'community' : 'household',
    transport,
    filtration,
    purifier: filtration,
    sensitivities,
    commute: raw.commute ? base.commute : commuteDefaults[transport],
    concerns: [...new Set(concerns)],
  };
}

/** Extra actions for the three planning lenses: walking families, drivers, organisers. */
function personaActions(profile, air, b) {
  const list = [];
  const add = (action) => list.push({
    doseSaved: 0, co2Saved: 0, costImpact: 0, localG: 0,
    scope: 'household', effort: 'easy', ...action,
  });

  if (profile.transport === 'walk' || (profile.children > 0 && profile.mode === 'household')) {
    add({
      id: 'school-route', category: 'habits', icon: '🚶', title: 'Take the quieter street to school',
      short: 'A back route away from the main road cuts what you breathe on the walk.',
      when: 'Morning school run',
      detail: `On an AQI ${air.aqi} morning, choose side streets and keep children off the busiest corridor. If a mask is available and the child is old enough to wear it well, use a fitted N95. Keep the walk short rather than skipping it entirely.`,
      why: 'Roadside particle levels fall quickly a block or two away from heavy traffic — route choice changes exposure without changing the routine.',
      steps: ['Pick the quieter route the night before', 'Wait away from the kerb at crossings', 'Keep outdoor play short on high-AQI days'],
      doseSaved: Math.round(b.outdoorDose * 0.2),
    });
  }

  if (profile.filtration === 'none') {
    add({
      id: 'clean-room', category: 'indoor', icon: '🪟', title: 'Make one room the clean-air room',
      short: 'Close it early, seal the door gap and keep cooking smoke out.',
      when: 'Before bed and during the worst hours',
      detail: 'Pick a bedroom, shut its windows before traffic peaks, roll a towel along the door gap and keep incense, candles and cooking out of it. A single well-sealed room is a realistic no-equipment fallback when there is no purifier.',
      why: 'You spend roughly eight hours asleep in one room. Without filtration, keeping that room sealed is the cheapest way to lower what the family inhales.',
      steps: ['Close the room before the evening peak', 'Use a damp towel under the door', 'Move cooking and burning to another area'],
      doseSaved: Math.round((b.sleepDose + b.activeDose) * 0.1),
    });
  }

  if (profile.transport === 'car') {
    add({
      id: 'recirculate', category: 'habits', icon: '🚗', title: 'Use recirculation in traffic',
      short: 'Keep windows up and the cabin on recirculate in queues and tunnels.',
      when: 'Morning drive',
      detail: 'On polluted roads, closed windows with recirculation keep more exhaust outside the cabin. Change the cabin filter if it is old. This reduces your own exposure but does not clean the street air.',
      why: 'A car is not clean air by default — in a jam it can be a concentrated exposure space.',
      steps: ['Close windows before entering the busy corridor', 'Switch to recirculate in queues', 'Replace a clogged cabin filter'],
      doseSaved: Math.round(b.outdoorDose * 0.15),
    });
    add({
      id: 'one-trip-transit', category: 'commute', icon: '🚇', title: 'Replace one car trip this week',
      short: 'One bus or metro ride instead of a drive, with the emissions saving shown in the calculator.',
      when: 'Any day this week',
      detail: 'Pick a single trip that works with transit. Use the impact calculator below with your real round-trip distance and trips per week — we only claim tailpipe CO₂, not a change in local AQI.',
      why: 'One repeatable trip is easier to keep than a wholesale change, and the saving compounds weekly.',
      steps: ['Choose one fixed trip', 'Check the transit timetable once', 'Use the calculator for your actual distance'],
      co2Saved: 0.55,
    });
  }

  if (profile.mode === 'community') {
    add({
      id: 'community-alert', category: 'community', icon: '📣', title: 'Send a morning AQI note to the school',
      short: 'Share the reading, source and one clear action with families before the school run.',
      when: 'Before 8 am',
      detail: `Post today's AQI ${air.aqi} (${describeSource(air)}) with one instruction: keep outdoor play short and use the quieter route. Include the source and time so families can check it themselves.`,
      why: 'A shared, sourced message helps families act at the same time instead of guessing.',
      steps: ['Copy the city, source and time from this page', 'Send via the school messaging group', 'Ask the school to repeat it on high-AQI days'],
      scope: 'community',
    });
    add({
      id: 'no-burn-pledge', category: 'community', icon: '🔥', title: 'Start a no-burn agreement',
      short: 'Ask neighbours and the school to stop burning leaves and waste.',
      when: 'Today',
      detail: 'Open burning adds particles right where people walk. A simple written pledge with a compost or collection alternative is more effective than a one-off reminder.',
      why: 'One burn pile affects several households — a group agreement changes the shared air, not just one home.',
      steps: ['Draft three short rules', 'Get ten households to agree', 'Arrange a green-waste collection point'],
      scope: 'community',
      localG: 250,
    });
    add({
      id: 'carpool-rota', category: 'community', icon: '🤝', title: 'Set up a school-run carpool rota',
      short: 'Four families, one car on rotation days.',
      when: 'This evening',
      detail: 'A four-family rota removes three cars from the school gate on rota days. Rotate the driver so the cost and benefit are shared, and agree a no-idling rule while waiting.',
      why: 'Fewer cars at the gate means less exhaust where children actually walk.',
      steps: ['Find three neighbours on the same route', 'Agree a four-day rota', 'Ask the school to mark a no-idling zone'],
      scope: 'community',
      co2Saved: 0.8,
      localG: 40,
    });
  }

  return list;
}

function augment(action) {
  const meta = META[action.id] || { time: 'midday', type: 'exposure', cost: 'free', source: 'epaAqi' };
  return {
    ...action,
    time: meta.time,
    kind: meta.type,
    cost: meta.cost,
    noCost: meta.cost !== 'purchase',
    typeLabel: TYPE_LABEL[meta.type] || TYPE_LABEL.exposure,
    sourceId: meta.source,
    source: sourceLabel(meta.source),
    sourceUrl: SOURCES[meta.source]?.url || '',
    what: action.title,
  };
}

function pickForSlot(candidates, count = 3) {
  const picked = [];
  const kinds = new Set();
  const ordered = [...candidates].sort((a, b) => (b.score || 0) - (a.score || 0));
  // Prefer one exposure and one emissions action when both exist in the slot.
  for (const kind of ['exposure', 'emissions', 'both']) {
    const found = ordered.find((a) => a.kind === kind && !picked.includes(a));
    if (found && picked.length < count) { picked.push(found); kinds.add(found.kind); }
  }
  for (const action of ordered) {
    if (picked.length >= count) break;
    if (!picked.includes(action)) picked.push(action);
  }
  return picked.map(({ score, ...action }) => action);
}

export function buildDayPlan(rawProfile, air) {
  const profile = normalizeDayProfile(rawProfile);
  const baseline = computeBaseline(profile, air);
  const baseActions = buildActions(profile, air, baseline)
    .filter((a) => !(profile.mode === 'community' && a.id === 'community-carpool'))
    .map(augment);
  const all = [
    ...baseActions,
    ...personaActions(profile, air, baseline).map(augment),
  ];
  const ranked = rankActions(all, profile).map((a) => ({ ...a, score: a.score + (a.scope === 'community' && profile.mode === 'community' ? 0.8 : 0) }));

  const dayPlan = {};
  for (const slot of ['morning', 'midday', 'evening']) {
    dayPlan[slot] = pickForSlot(ranked.filter((a) => a.time === slot), 3);
  }

  const priorities = [];
  if (profile.transport === 'walk' || (profile.children > 0 && profile.mode === 'household')) priorities.push(['morning', 'school-route']);
  if (profile.filtration === 'none') priorities.push(['evening', 'clean-room']);
  if (profile.transport === 'car') priorities.push(['morning', 'recirculate'], ['midday', 'one-trip-transit']);
  if (profile.mode === 'community') priorities.push(['morning', 'community-alert'], ['midday', 'no-burn-pledge'], ['evening', 'carpool-rota']);
  for (const [slot, id] of priorities) {
    if (dayPlan[slot].some((a) => a.id === id)) continue;
    const candidate = ranked.find((a) => a.id === id);
    if (!candidate) continue;
    const { score, ...clean } = candidate;
    dayPlan[slot][dayPlan[slot].length - 1] = clean;
  }

  const selected = [...dayPlan.morning, ...dayPlan.midday, ...dayPlan.evening];
  const impact = summarize(selected, baseline, profile);
  const headlineAction = ranked[0] || selected[0] || null;
  const topThree = [...ranked].filter((a) => selected.some((s) => s.id === a.id)).slice(0, 3);
  const sourceText = describeSource(air);

  const guideContext = {
    city: air.place?.name || 'your area',
    aqi: air.aqi,
    advisory: air.advisory?.label,
    source: sourceText,
    localTime: air.localTime,
    bestWindow: air.bestWindow,
    profile: {
      mode: profile.mode, transport: profile.transport, filtration: profile.filtration,
      children: profile.children, elders: profile.elders, sensitivities: profile.sensitivities,
      cookingFuel: profile.cookingFuel, heating: profile.heating,
    },
    plan: selected.map((a) => ({
      id: a.id, title: a.title, time: a.time, kind: a.kind, noCost: a.noCost,
      why: a.why, detail: a.detail, source: a.source,
    })),
    guidance: Object.values(SOURCES).map(({ label, note }) => ({ label, note })),
  };

  return {
    air: {
      city: air.place?.name || 'Your area',
      country: air.place?.country || '',
      aqi: air.aqi,
      pm25: air.pm25,
      pm10: air.pm10,
      advisory: air.advisory,
      dominant: air.dominant,
      bestWindow: air.bestWindow,
      hourly: (air.hourly || []).slice(0, 18),
      source: air.source,
      sourceText,
      sourceNote: air.note || null,
      sourceUrl: air.source === 'open-meteo' ? SOURCES.openMeteo.url : '',
      localTime: air.localTime,
      fetchedAt: air.fetchedAt,
    },
    profile,
    baseline: {
      indoorPm25: Math.round(baseline.indoorPM),
      dailyDoseMicrograms: Math.round(baseline.totalDose),
    },
    impact,
    headlineAction,
    dayPlan,
    library: all,
    guideContext,
    communitySheet: {
      city: air.place?.name || 'Your area',
      aqi: air.aqi,
      source: sourceText,
      localTime: air.localTime,
      sourceNote: air.note || '',
      actions: (topThree.length ? topThree : selected.slice(0, 3)).map((a) => ({
        id: a.id, title: a.title, what: a.what, why: a.why,
        kind: a.typeLabel, time: a.time, source: a.source,
      })),
    },
    meta: {
      llmAvailable: false,
      generatedAt: new Date().toISOString(),
    },
  };
}
