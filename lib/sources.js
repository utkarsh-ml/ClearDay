/** Sourced guidance used by the day plan, the AI guide and the printout. */

export const SOURCES = {
  openMeteo: {
    label: 'Open-Meteo Air Quality API (CAMS model)',
    url: 'https://open-meteo.com/en/docs/air-quality-api',
    note: 'Modeled hourly air-quality estimates, not a regulatory monitor.',
  },
  epaAqi: {
    label: 'US EPA / AirNow AQI basics',
    url: 'https://www.airnow.gov/aqi/aqi-basics/',
    note: 'AQI categories and health messages.',
  },
  whoAir: {
    label: 'WHO ambient air quality guidance',
    url: 'https://www.who.int/news-room/fact-sheets/detail/ambient-(outdoor)-air-quality-and-health',
    note: 'PM2.5 health guidance and exposure reduction principles.',
  },
  ncdcIndoor: {
    label: 'MoHFW / NCDC India indoor air & health advisory (NPCCHH)',
    url: 'https://ncdc.mohfw.gov.in',
    note: 'Government of India guidance on reducing indoor PM2.5: closing windows at peak pollution, kitchen exhaust, avoiding incense/coils, wet cleaning, and certified HEPA filtration.',
  },
  cpcbAqi: {
    label: 'CPCB India National Air Quality Index',
    url: 'https://cpcb.nic.in',
    note: 'Central Pollution Control Board (India) air quality monitoring and health impact advisories.',
  },
  cdcMask: {
    label: 'CDC/NIOSH respirator guidance',
    url: 'https://www.cdc.gov/niosh/npptl/topics/respirators/disp_part/N95list1.html',
    note: 'Fit and use of N95 filtering facepiece respirators.',
  },
  defra: {
    label: 'UK DEFRA greenhouse gas conversion factors',
    url: 'https://www.gov.uk/government/collections/government-conversion-factors-for-company-reporting',
    note: 'Average car tailpipe CO₂ per kilometre.',
  },
  manual: {
    label: 'User-supplied manual reading',
    url: '',
    note: 'Entered by the user; not independently verified.',
  },
  example: {
    label: 'Illustrative example scenario',
    url: '',
    note: 'Fixed demonstration value, not a live measurement.',
  },
};

export const sourceList = Object.entries(SOURCES).map(([id, source]) => ({ id, ...source }));

export function sourceLabel(id) {
  return SOURCES[id]?.label || 'ClearDay guidance';
}
