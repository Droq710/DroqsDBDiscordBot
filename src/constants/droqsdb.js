const COUNTRY_CHOICES = Object.freeze([
  'Argentina',
  'Canada',
  'Cayman Islands',
  'China',
  'Hawaii',
  'Japan',
  'Mexico',
  'South Africa',
  'Switzerland',
  'UAE',
  'United Kingdom'
]);

const RUN_CATEGORY_CHOICES = Object.freeze([
  { name: 'Plushies', value: 'plushies' },
  { name: 'Flowers', value: 'flowers' },
  { name: 'Drugs', value: 'drugs' }
]);

const CATEGORY_ITEM_NAMES = Object.freeze({
  plushies: new Set(
    [
      'Jaguar Plushie',
      'Lion Plushie',
      'Camel Plushie',
      'Panda Plushie',
      'Monkey Plushie',
      'Chamois Plushie',
      'Wolverine Plushie',
      'Red Fox Plushie',
      'Sheep Plushie',
      'Kitten Plushie',
      'Nessie Plushie',
      'Stingray Plushie',
      'Dahlia Plushie'
    ].map(normalizeDroqsdbText)
  ),
  flowers: new Set(
    [
      'African Violet',
      'Banana Orchid',
      'Cherry Blossom',
      'Crocus',
      'Dahlia',
      'Edelweiss',
      'Heather',
      'Orchid',
      'Peony',
      'Red Rose',
      'Tribulus Omanense'
    ].map(normalizeDroqsdbText)
  ),
  drugs: new Set(
    [
      'Xanax',
      'Vicodin',
      'Ecstasy',
      'Ketamine',
      'LSD',
      'Opium',
      'Shrooms',
      'Speed',
      'Cannabis'
    ].map(normalizeDroqsdbText)
  )
});

const STANDARD_ROUND_TRIP_MINUTES_BY_COUNTRY = Object.freeze({
  Mexico: 52,
  'Cayman Islands': 70,
  Canada: 82,
  Hawaii: 268,
  'United Kingdom': 318,
  Argentina: 334,
  Switzerland: 350,
  Japan: 450,
  China: 484,
  UAE: 542,
  'South Africa': 594
});

function normalizeDroqsdbText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function categoryLabel(category) {
  const normalized = normalizeDroqsdbText(category);
  const match = RUN_CATEGORY_CHOICES.find((entry) => entry.value === normalized);

  if (match) {
    return match.name;
  }

  if (!normalized) {
    return 'Unknown';
  }

  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function matchesTrackedRunCategory(itemName, category) {
  const itemSet = CATEGORY_ITEM_NAMES[normalizeDroqsdbText(category)];
  return itemSet ? itemSet.has(normalizeDroqsdbText(itemName)) : false;
}

function getTrackedRunCategory(itemName) {
  const normalizedItemName = normalizeDroqsdbText(itemName);

  for (const category of Object.keys(CATEGORY_ITEM_NAMES)) {
    if (CATEGORY_ITEM_NAMES[category].has(normalizedItemName)) {
      return category;
    }
  }

  return null;
}

function getStandardRoundTripMinutes(country) {
  const normalizedCountry = String(country || '').trim();
  const minutes = STANDARD_ROUND_TRIP_MINUTES_BY_COUNTRY[normalizedCountry];
  return Number.isFinite(minutes) ? minutes : null;
}

function getDefaultTrackedRoundTripHours() {
  const roundTripMinutes = Object.values(STANDARD_ROUND_TRIP_MINUTES_BY_COUNTRY)
    .map((minutes) => Number(minutes))
    .filter((minutes) => Number.isFinite(minutes) && minutes > 0);
  const maxMinutes = roundTripMinutes.length ? Math.max(...roundTripMinutes) : 600;
  return Math.max(0.5, Math.ceil(maxMinutes / 30) / 2);
}

module.exports = {
  CATEGORY_ITEM_NAMES,
  COUNTRY_CHOICES,
  RUN_CATEGORY_CHOICES,
  STANDARD_ROUND_TRIP_MINUTES_BY_COUNTRY,
  categoryLabel,
  getDefaultTrackedRoundTripHours,
  getStandardRoundTripMinutes,
  getTrackedRunCategory,
  matchesTrackedRunCategory,
  normalizeDroqsdbText
};
