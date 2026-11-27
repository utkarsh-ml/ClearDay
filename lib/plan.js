import { llmEnabled, llmInfo, askAssistant } from './llm.js';
import { buildDayPlan } from './dayplan.js';

/** Build the personalised day plan. All numbers come from the transparent model. */
export async function createPlan(rawProfile, air) {
  const plan = buildDayPlan(rawProfile, air);
  plan.meta.llmAvailable = llmEnabled;
  plan.meta.llmProvider = llmInfo.provider;
  plan.meta.llmModel = llmInfo.model;
  return plan;
}

const FOLLOW_UPS = [
  'We walk to school and have no purifier. What can we change today?',
  'I drive to work — what should I change?',
  'Which actions cost nothing?',
  'How do we share this with our school?',
];

function rulesAnswer(question, planResult, errorReason = null) {
  const q = String(question || '').toLowerCase();
  const { air, profile, dayPlan, library } = planResult;
  const all = Object.values(dayPlan).flat();
  const find = (ids) => all.find((a) => ids.includes(a.id)) || library.find((a) => ids.includes(a.id));
  const sourceLine = (a) => a?.source ? ` Source: ${a.source}.` : '';
  const label = errorReason
    ? `Rules-based answer — AI model unavailable (${errorReason})`
    : 'Rules-based answer — AI model unavailable';

  const header = `${air.city}: US AQI ${air.aqi} (${air.advisory?.label}) from ${air.sourceText}, local time ${air.localTime}.`;

  let action = null;
  if (/(walk|school|purifier|no filter|no filtration|child|kid)/.test(q)) {
    action = find(['school-route', 'clean-room', 'school-air-alert', 'mask']);
  } else if (/(drive|car|commut|traffic|bus|metro)/.test(q)) {
    action = find(['recirculate', 'one-trip-transit', 'transit-swap', 'no-idling']);
  } else if (/(community|school group|organis|neighbour|street|share)/.test(q)) {
    action = find(['community-alert', 'no-burn-pledge', 'carpool-rota', 'community-carpool']);
  } else if (/(free|no cost|cheap|afford|buy|money)/.test(q)) {
    action = all.find((a) => a.noCost) || library.find((a) => a.noCost);
  } else if (/(window|vent|air out|fresh air)/.test(q)) {
    action = find(['vent-timing', 'clean-room']);
  } else if (/(cook|stove|kitchen|smoke)/.test(q)) {
    action = find(['range-hood', 'clean-cooking', 'no-indoor-burning']);
  } else if (/(co2|carbon|emission|calculator|distance)/.test(q)) {
    action = find(['one-trip-transit', 'transit-swap', 'no-idling']);
  }

  if (!action) {
    const first = all[0];
    return {
      answer: `${header} Your plan focuses on: ${all.slice(0, 3).map((a) => a.what).join('; ')}. Ask me about walking to school, driving, free options, windows, cooking or sharing this with a school group.${sourceLine(first)}`,
      followUps: FOLLOW_UPS,
      source: 'rules',
      label,
    };
  }

  const noCost = action.noCost ? ' This option needs no equipment purchase.' : '';
  const profileNote = profile.transport === 'walk' && profile.filtration === 'none'
    ? ' That matches your walking routine and no filtration at home.'
    : profile.mode === 'community'
      ? ' That is framed for a school or residents’ group.'
      : profile.transport === 'car'
        ? ' That is framed for your driving routine.'
        : '';

  return {
    answer: `${header} ${action.what}: ${action.detail.split('.').slice(0, 2).join('.')}.${profileNote}${noCost}${sourceLine(action)}`,
    followUps: FOLLOW_UPS,
    source: 'rules',
    label,
  };
}

/** Grounded conversational answer, clearly labelled when the model is unavailable. */
export async function answerQuestion(question, planResult, history = []) {
  if (!llmEnabled || !planResult?.guideContext) return rulesAnswer(question, planResult);

  const res = await askAssistant({ question, context: planResult.guideContext, history });
  const generated = res?.ok ? res.data : null;
  if (!generated || typeof generated.answer !== 'string' || generated.answer.trim().length < 10) {
    return rulesAnswer(question, planResult, res?.error || 'invalid model response');
  }
  const providerLabel = /gemini/i.test(llmInfo.provider || '') ? 'Gemini AI guide' : (llmInfo.provider || 'AI guide');
  return {
    answer: generated.answer.slice(0, 1600),
    followUps: Array.isArray(generated.followUps) && generated.followUps.length
      ? generated.followUps.filter((x) => typeof x === 'string').slice(0, 4)
      : FOLLOW_UPS,
    source: 'genai',
    label: `${providerLabel} · grounded in your plan and sourced guidance`,
  };
}
