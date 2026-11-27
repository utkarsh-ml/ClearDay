/**
 * Tailpipe CO₂ calculator. Browser-safe and shared by the server and the UI.
 * Only estimates tailpipe CO₂ — never local AQI or health outcomes.
 */

export const CO2_KG_PER_KM = 0.192; // average petrol car, UK DEFRA conversion factors
export const WEEKS_PER_YEAR = 52;

export const CALC_ASSUMPTIONS = [
  `Tailpipe CO₂ factor: ${CO2_KG_PER_KM} kg CO₂ per km travelled (average petrol car, UK DEFRA conversion factors).`,
  'Round-trip distance × trips replaced per week × 52 weeks × factor.',
  'Assumes each replaced trip is a car trip that no longer happens. No change in local AQI or personal health is claimed.',
  'Does not include fuel production, electricity for transit, or embodied vehicle emissions.',
];

export function estimateAvoidedCO2(roundTripKm, tripsPerWeek) {
  const km = Math.max(0, Number(roundTripKm) || 0);
  const trips = Math.max(0, Number(tripsPerWeek) || 0);
  const kmPerWeek = km * trips;
  const kgPerWeek = kmPerWeek * CO2_KG_PER_KM;
  return {
    inputs: { roundTripKm: km, tripsPerWeek: trips },
    kmPerWeek,
    kmPerYear: kmPerWeek * WEEKS_PER_YEAR,
    kgPerWeek: Math.round(kgPerWeek * 100) / 100,
    kgPerMonth: Math.round(kgPerWeek * 52 / 12 * 100) / 100,
    kgPerYear: Math.round(kgPerWeek * WEEKS_PER_YEAR * 10) / 10,
    formula: `${km} km × ${trips} trips × 52 weeks × ${CO2_KG_PER_KM} kg/km`,
    assumptions: CALC_ASSUMPTIONS,
    source: 'UK DEFRA greenhouse gas conversion factors (average petrol car)',
    sourceUrl: 'https://www.gov.uk/government/collections/government-conversion-factors-for-company-reporting',
  };
}
