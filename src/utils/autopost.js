const {
  categoryLabel,
  getStandardRoundTripMinutes,
  getTrackedRunCategory
} = require('../constants/droqsdb');

const DEFAULT_AUTOPOST_COUNT = 10;
const MIN_AUTOPOST_COUNT = 1;
const MAX_AUTOPOST_COUNT = 10;

const AUTOPOST_MODES = Object.freeze({
  COUNT: 'count',
  FLIGHT_BUCKETS: 'flight_buckets',
  MIXED_HIGHLIGHTS: 'mixed_highlights'
});

const AUTOPOST_MODE_CHOICES = Object.freeze([
  { name: 'Top Count', value: AUTOPOST_MODES.COUNT },
  { name: 'Flight Buckets', value: AUTOPOST_MODES.FLIGHT_BUCKETS },
  { name: 'Mixed Highlights', value: AUTOPOST_MODES.MIXED_HIGHLIGHTS }
]);

const FLIGHT_BUCKETS = Object.freeze([
  Object.freeze({
    key: 'short',
    title: 'Short Flights (<= 2h RT)',
    summaryLabel: 'Short',
    minMinutes: 0,
    maxMinutes: 120
  }),
  Object.freeze({
    key: 'medium',
    title: 'Medium Flights (2h-6h RT)',
    summaryLabel: 'Medium',
    minMinutes: 121,
    maxMinutes: 360
  }),
  Object.freeze({
    key: 'long',
    title: 'Long Haul (> 6h RT)',
    summaryLabel: 'Long Haul',
    minMinutes: 361,
    maxMinutes: Number.POSITIVE_INFINITY
  })
]);

function normalizeAutopostCount(value, fallback = DEFAULT_AUTOPOST_COUNT) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed)) {
    return fallback;
  }

  return Math.min(MAX_AUTOPOST_COUNT, Math.max(MIN_AUTOPOST_COUNT, parsed));
}

function normalizeAutopostMode(value, fallback = AUTOPOST_MODES.COUNT) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

  if (normalized === AUTOPOST_MODES.FLIGHT_BUCKETS) {
    return AUTOPOST_MODES.FLIGHT_BUCKETS;
  }

  if (normalized === AUTOPOST_MODES.MIXED_HIGHLIGHTS) {
    return AUTOPOST_MODES.MIXED_HIGHLIGHTS;
  }

  if (normalized === AUTOPOST_MODES.COUNT) {
    return AUTOPOST_MODES.COUNT;
  }

  return fallback;
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

function formatAutopostMode(mode) {
  switch (normalizeAutopostMode(mode)) {
    case AUTOPOST_MODES.FLIGHT_BUCKETS:
      return 'Flight Buckets';
    case AUTOPOST_MODES.MIXED_HIGHLIGHTS:
      return 'Mixed Highlights';
    case AUTOPOST_MODES.COUNT:
    default:
      return 'Top Count';
  }
}

function formatAutopostModeSummary({
  mode = AUTOPOST_MODES.COUNT,
  count = DEFAULT_AUTOPOST_COUNT
} = {}) {
  switch (normalizeAutopostMode(mode)) {
    case AUTOPOST_MODES.FLIGHT_BUCKETS:
      return 'Top 3 short, medium, and long-haul runs.';
    case AUTOPOST_MODES.MIXED_HIGHLIGHTS:
      return 'Top overall, top plushie, top flower, top drug, and top short, medium, and long-haul runs.';
    case AUTOPOST_MODES.COUNT:
    default:
      return `Top ${normalizeAutopostCount(count)} current runs.`;
  }
}

function buildAutopostTitle({
  mode = AUTOPOST_MODES.COUNT,
  country = null,
  category = null,
  count = DEFAULT_AUTOPOST_COUNT
} = {}) {
  const normalizedMode = normalizeAutopostMode(mode);

  if (normalizedMode === AUTOPOST_MODES.FLIGHT_BUCKETS) {
    if (country && category) {
      return `Hourly ${categoryLabel(category)} Flight Buckets for ${country}`;
    }

    if (country) {
      return `Hourly Flight Buckets for ${country}`;
    }

    if (category) {
      return `Hourly ${categoryLabel(category)} Flight Buckets`;
    }

    return 'Hourly DroqsDB Flight Buckets';
  }

  if (normalizedMode === AUTOPOST_MODES.MIXED_HIGHLIGHTS) {
    if (country && category) {
      return `Hourly ${categoryLabel(category)} Highlights for ${country}`;
    }

    if (country) {
      return `Hourly Highlights for ${country}`;
    }

    if (category) {
      return `Hourly ${categoryLabel(category)} Highlights`;
    }

    return 'Hourly DroqsDB Highlights';
  }

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
  mode = AUTOPOST_MODES.COUNT,
  country = null,
  category = null
} = {}) {
  const normalizedMode = normalizeAutopostMode(mode);

  if (normalizedMode === AUTOPOST_MODES.FLIGHT_BUCKETS) {
    if (country && category) {
      return `Current profitable in-stock ${categoryLabel(category).toLowerCase()} runs for ${country}, grouped by standard round-trip flight length.`;
    }

    if (country) {
      return `Current profitable in-stock runs for ${country}, grouped by standard round-trip flight length.`;
    }

    if (category) {
      return `Current profitable in-stock ${categoryLabel(category).toLowerCase()} runs, grouped by standard round-trip flight length.`;
    }

    return 'Current profitable in-stock runs grouped by standard round-trip flight length.';
  }

  if (normalizedMode === AUTOPOST_MODES.MIXED_HIGHLIGHTS) {
    if (country && category) {
      return `Current profitable in-stock ${categoryLabel(category).toLowerCase()} highlight runs for ${country}.`;
    }

    if (country) {
      return `Current profitable in-stock highlight runs for ${country}.`;
    }

    if (category) {
      return `Current profitable in-stock ${categoryLabel(category).toLowerCase()} highlight runs.`;
    }

    return 'Current profitable in-stock highlight runs.';
  }

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

function sortRunsByProfitPerMinuteDesc(left, right) {
  return Number(right?.profitPerMinute || 0) - Number(left?.profitPerMinute || 0);
}

function getFlightBucketForRun(run) {
  const roundTripMinutes = getStandardRoundTripMinutes(run?.country);

  if (!Number.isFinite(roundTripMinutes)) {
    return null;
  }

  return (
    FLIGHT_BUCKETS.find(
      (bucket) => roundTripMinutes >= bucket.minMinutes && roundTripMinutes <= bucket.maxMinutes
    ) || null
  );
}

function buildAutopostFlightBucketSections(runs, limit = 3) {
  const sortedRuns = Array.isArray(runs) ? runs.slice().sort(sortRunsByProfitPerMinuteDesc) : [];
  const normalizedLimit = Math.max(1, Math.round(Number(limit) || 3));

  return FLIGHT_BUCKETS.map((bucket) => ({
    key: bucket.key,
    title: bucket.title,
    runs: sortedRuns
      .filter((run) => getFlightBucketForRun(run)?.key === bucket.key)
      .slice(0, normalizedLimit)
  }));
}

function buildAutopostMixedHighlights(runs) {
  const sortedRuns = Array.isArray(runs) ? runs.slice().sort(sortRunsByProfitPerMinuteDesc) : [];

  return {
    overall: sortedRuns[0] || null,
    plushies: sortedRuns.find((run) => getTrackedRunCategory(run?.itemName) === 'plushies') || null,
    flowers: sortedRuns.find((run) => getTrackedRunCategory(run?.itemName) === 'flowers') || null,
    drugs: sortedRuns.find((run) => getTrackedRunCategory(run?.itemName) === 'drugs') || null,
    short: sortedRuns.find((run) => getFlightBucketForRun(run)?.key === 'short') || null,
    medium: sortedRuns.find((run) => getFlightBucketForRun(run)?.key === 'medium') || null,
    long: sortedRuns.find((run) => getFlightBucketForRun(run)?.key === 'long') || null
  };
}

module.exports = {
  AUTOPOST_MODE_CHOICES,
  AUTOPOST_MODES,
  DEFAULT_AUTOPOST_COUNT,
  FLIGHT_BUCKETS,
  MAX_AUTOPOST_COUNT,
  MIN_AUTOPOST_COUNT,
  buildAutopostDescription,
  buildAutopostEmptyDescription,
  buildAutopostEmptyTitle,
  buildAutopostFlightBucketSections,
  buildAutopostMixedHighlights,
  buildAutopostTitle,
  formatAutopostFilters,
  formatAutopostMode,
  formatAutopostModeSummary,
  getFlightBucketForRun,
  normalizeAutopostCount,
  normalizeAutopostMode,
  normalizeAutopostFilters
};
