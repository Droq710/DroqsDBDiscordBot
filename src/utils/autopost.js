const { categoryLabel } = require('../constants/droqsdb');

const DEFAULT_AUTOPOST_COUNT = 10;
const MIN_AUTOPOST_COUNT = 1;
const MAX_AUTOPOST_COUNT = 10;

function normalizeAutopostCount(value, fallback = DEFAULT_AUTOPOST_COUNT) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed)) {
    return fallback;
  }

  return Math.min(MAX_AUTOPOST_COUNT, Math.max(MIN_AUTOPOST_COUNT, parsed));
}

function normalizeAutopostFilters({
  country = null,
  category = null
} = {}) {
  return {
    country: typeof country === 'string' && country.trim() ? country.trim() : null,
    category: typeof category === 'string' && category.trim() ? category.trim().toLowerCase() : null
  };
}

function formatAutopostFilters({
  country = null,
  category = null
} = {}) {
  const parts = [];

  if (country) {
    parts.push(`Country: ${country}`);
  }

  if (category) {
    parts.push(`Category: ${categoryLabel(category)}`);
  }

  return parts.length ? parts.join(' | ') : 'All profitable runs';
}

function buildAutopostTitle({
  country = null,
  category = null,
  count = DEFAULT_AUTOPOST_COUNT
} = {}) {
  if (country && category) {
    return `Hourly ${categoryLabel(category)} Runs for ${country}`;
  }

  if (country) {
    return `Hourly Runs for ${country}`;
  }

  if (category) {
    return `Hourly ${categoryLabel(category)} Runs`;
  }

  return `Hourly DroqsDB Top ${count} Runs`;
}

function buildAutopostDescription({
  country = null,
  category = null
} = {}) {
  if (country && category) {
    return `Current profitable in-stock ${categoryLabel(category).toLowerCase()} runs for ${country} from the DroqsDB Public API.`;
  }

  if (country) {
    return `Current profitable in-stock runs for ${country} from the DroqsDB Public API.`;
  }

  if (category) {
    return `Current profitable in-stock ${categoryLabel(category).toLowerCase()} runs from the DroqsDB Public API.`;
  }

  return 'Current top profitable in-stock runs from the DroqsDB Public API.';
}

function buildAutopostEmptyTitle({
  country = null,
  category = null
} = {}) {
  if (country && category) {
    return `No ${categoryLabel(category)} Runs for ${country}`;
  }

  if (country) {
    return `No Runs for ${country}`;
  }

  if (category) {
    return `No ${categoryLabel(category)} Runs`;
  }

  return 'No Profitable Runs Available';
}

function buildAutopostEmptyDescription({
  country = null,
  category = null
} = {}) {
  if (country && category) {
    return `DroqsDB does not currently report any profitable in-stock ${categoryLabel(category).toLowerCase()} runs for ${country}.`;
  }

  if (country) {
    return `DroqsDB does not currently report any profitable in-stock runs for ${country}.`;
  }

  if (category) {
    return `DroqsDB does not currently report any profitable in-stock ${categoryLabel(category).toLowerCase()} runs right now.`;
  }

  return 'DroqsDB does not currently report any profitable in-stock runs right now.';
}

module.exports = {
  DEFAULT_AUTOPOST_COUNT,
  MAX_AUTOPOST_COUNT,
  MIN_AUTOPOST_COUNT,
  buildAutopostDescription,
  buildAutopostEmptyDescription,
  buildAutopostEmptyTitle,
  buildAutopostTitle,
  formatAutopostFilters,
  normalizeAutopostCount,
  normalizeAutopostFilters
};
