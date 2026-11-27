import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateCpcb, aqiCategory } from '../lib/standards.js';
function sample(extra = {}) {
  return {time:Array.from({length:24}, (_,i) => 1700000000 + i*3600),
    pm2_5:Array(24).fill(45), pm10:Array(24).fill(30), nitrogen_dioxide:Array(24).fill(10), ...extra};
}
test('CPCB public example, averaging coverage, no particulate and severe lower bound', () => {
  assert.equal(calculateCpcb(sample(),23).value,75);
  assert.equal(calculateCpcb(sample(),14).value,null);
  assert.equal(calculateCpcb(sample({pm2_5:null,pm10:null}),23).value,null);
  assert.equal(calculateCpcb(sample({pm2_5:Array(24).fill(251)}),23).lowerBound,401);
  assert.equal(calculateCpcb(sample({pm2_5:Array(24).fill(0),pm10:Array(24).fill(0),nitrogen_dioxide:Array(24).fill(0)}),23).value,0);
});
test('CPCB uses mg/m³ for CO and hourly ozone for high concentrations', () => {
  const co=Array(24).fill(1000);
  co.fill(2000,16);
  assert.equal(calculateCpcb(sample({carbon_monoxide:co}),23).value,100);
  const ozone=Array(24).fill(30);
  ozone[23]=748;
  assert.equal(calculateCpcb(sample({ozone}),23).value,400);
  assert.equal(aqiCategory('us',160).label,'Unhealthy');
  assert.equal(aqiCategory('cpcb',160).label,'Moderate');
  assert.equal(aqiCategory('us',null),null);
});
