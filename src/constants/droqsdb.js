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

function categoryLabel(category) {
  const normalized = String(category || '').trim().toLowerCase();
  const match = RUN_CATEGORY_CHOICES.find((entry) => entry.value === normalized);

  if (match) {
    return match.name;
  }

  if (!normalized) {
    return 'Unknown';
  }

  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

module.exports = {
  COUNTRY_CHOICES,
  RUN_CATEGORY_CHOICES,
  categoryLabel
};
