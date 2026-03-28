const {
  COUNTRY_CHOICES,
  RUN_CATEGORY_CHOICES,
  categoryLabel,
  getStandardRoundTripMinutes,
  getTrackedRunCategory,
  normalizeTrackedRunCategory,
  resolveTrackedCountryName
} = require('../constants/droqsdb');

const DEFAULT_AUTOPOST_COUNT = 10;
const MIN_AUTOPOST_COUNT = 1;
const MAX_AUTOPOST_COUNT = 10;

const AUTOPOST_MODES = Object.freeze({
  TOP_N: 'top_n',
  FLIGHT_GROUPS: 'flight_groups',
  CATEGORY_GROUPS: 'category_groups',
  FULL_BREAKDOWN: 'full_breakdown'
});

const AUTOPOST_MODE_CHOICES = Object.freeze([
  { name: 'Top N', value: AUTOPOST_MODES.TOP_N },
  { name: 'Flight Groups', value: AUTOPOST_MODES.FLIGHT_GROUPS },
  { name: 'Category Groups', value: AUTOPOST_MODES.CATEGORY_GROUPS },
  { name: 'Full Breakdown', value: AUTOPOST_MODES.FULL_BREAKDOWN }
]);

const FLIGHT_GROUPS = Object.freeze([
  Object.freeze({
    key: 'short',
    title: '✈️ Short Flights',
    minMinutes: 0,
    maxMinutes: 180
  }),
  Object.freeze({
    key: 'medium',
    title: '🛫 Medium Flights',
    minMinutes: 181,
    maxMinutes: 480
  }),
  Object.freeze({
    key: 'long',
    title: '🌍 Long Haul',
    minMinutes: 481,
    maxMinutes: Number.POSITIVE_INFINITY
  })
]);

const CATEGORY_GROUPS = Object.freeze([
  Object.freeze({
    key: 'drugs',
    title: '💊 Drugs'
  }),
  Object.freeze({
    key: 'flowers',
    title: '🌸 Flowers'
  }),
  Object.freeze({
    key: 'plushies',
    title: '🧸 Plushies'
  })
]);

const LEGACY_AUTOPOST_MODE_ALIASES = Object.freeze({
  count: AUTOPOST_MODES.TOP_N,
  flight_buckets: AUTOPOST_MODES.TOP_N,
  mixed_highlights: AUTOPOST_MODES.TOP_N
});

function normalizeAutopostCount(value, fallback = DEFAULT_AUTOPOST_COUNT) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed)) {
    return fallback;
  }

  return Math.min(MAX_AUTOPOST_COUNT, Math.max(MIN_AUTOPOST_COUNT, parsed));
}

function normalizeAutopostMode(value, fallback = AUTOPOST_MODES.TOP_N) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

  if (Object.values(AUTOPOST_MODES).includes(normalized)) {
    return normalized;
  }

  return LEGACY_AUTOPOST_MODE_ALIASES[normalized] || fallback;
}

function parseAutopostCategoryInput(value) {
  return parseAutopostListInput(value, {
    fieldLabel: 'categories',
    validValues: RUN_CATEGORY_CHOICES.map((entry) => entry.value),
    resolveValue: normalizeTrackedRunCategory,
    strict: true
  });
}

function parseAutopostCountryInput(value) {
  return parseAutopostListInput(value, {
    fieldLabel: 'countries',
    validValues: COUNTRY_CHOICES,
    resolveValue: resolveTrackedCountryName,
    strict: true
  });
}

function normalizeAutopostFilters({
  countries = [],
  categories = [],
  country = null,
  category = null
} = {}) {
  return {
    countries: parseAutopostListInput([countries, country], {
      fieldLabel: 'countries',
      validValues: COUNTRY_CHOICES,
      resolveValue: resolveTrackedCountryName,
      strict: false
    }).values,
    categories: parseAutopostListInput([categories, category], {
      fieldLabel: 'categories',
      validValues: RUN_CATEGORY_CHOICES.map((entry) => entry.value),
      resolveValue: normalizeTrackedRunCategory,
      strict: false
    }).values
  };
}

function formatAutopostFilters({
  countries = [],
  categories = []
} = {}) {
  const normalizedFilters = normalizeAutopostFilters({
    countries,
    categories
  });
  const parts = [];

  if (normalizedFilters.countries.length) {
    parts.push(`Countries: ${normalizedFilters.countries.join(', ')}`);
  }

  if (normalizedFilters.categories.length) {
    parts.push(
      `Categories: ${normalizedFilters.categories.map((category) => categoryLabel(category)).join(', ')}`
    );
  }

  return parts.length ? parts.join(' | ') : 'All profitable runs';
}

function formatAutopostMode(mode) {
  switch (normalizeAutopostMode(mode)) {
    case AUTOPOST_MODES.FLIGHT_GROUPS:
      return 'Flight Groups';
    case AUTOPOST_MODES.CATEGORY_GROUPS:
      return 'Category Groups';
    case AUTOPOST_MODES.FULL_BREAKDOWN:
      return 'Full Breakdown';
    case AUTOPOST_MODES.TOP_N:
    default:
      return 'Top N';
  }
}

function formatAutopostModeSummary({
  mode = AUTOPOST_MODES.TOP_N,
  count = DEFAULT_AUTOPOST_COUNT
} = {}) {
  switch (normalizeAutopostMode(mode)) {
    case AUTOPOST_MODES.FLIGHT_GROUPS:
      return 'Top 3 short, medium, and long-haul runs.';
    case AUTOPOST_MODES.CATEGORY_GROUPS:
      return 'Top 3 runs each for drugs, flowers, and plushies.';
    case AUTOPOST_MODES.FULL_BREAKDOWN:
      return 'Top 3 overall, by flight group, and by tracked category.';
    case AUTOPOST_MODES.TOP_N:
    default:
      return `Top ${normalizeAutopostCount(count)} ranked runs.`;
  }
}

function buildAutopostTitle({
  mode = AUTOPOST_MODES.TOP_N,
  count = DEFAULT_AUTOPOST_COUNT
} = {}) {
  switch (normalizeAutopostMode(mode)) {
    case AUTOPOST_MODES.FLIGHT_GROUPS:
      return 'Hourly DroqsDB Flight Groups';
    case AUTOPOST_MODES.CATEGORY_GROUPS:
      return 'Hourly DroqsDB Category Groups';
    case AUTOPOST_MODES.FULL_BREAKDOWN:
      return 'Hourly DroqsDB Full Breakdown';
    case AUTOPOST_MODES.TOP_N:
    default:
      return `Hourly DroqsDB Top ${normalizeAutopostCount(count)} Runs`;
  }
}

function buildAutopostDescription({
  mode = AUTOPOST_MODES.TOP_N,
  count = DEFAULT_AUTOPOST_COUNT,
  countries = [],
  categories = []
} = {}) {
  return [
    formatAutopostModeSummary({
      mode,
      count
    }),
    `Filters: ${formatAutopostFilters({ countries, categories })}`
  ].join('\n');
}

function buildAutopostEmptyTitle() {
  return 'No Matching Runs';
}

function buildAutopostEmptyDescription({
  countries = [],
  categories = []
} = {}) {
  return [
    'DroqsDB does not currently report any profitable viable runs for the selected filters.',
    `Filters: ${formatAutopostFilters({ countries, categories })}`
  ].join('\n');
}

function getFlightGroupForRun(run) {
  const roundTripMinutes = getStandardRoundTripMinutes(run?.country);

  if (!Number.isFinite(roundTripMinutes)) {
    return null;
  }

  return (
    FLIGHT_GROUPS.find(
      (group) => roundTripMinutes >= group.minMinutes && roundTripMinutes <= group.maxMinutes
    ) || null
  );
}

function buildAutopostSections({
  mode = AUTOPOST_MODES.TOP_N,
  runs = [],
  count = DEFAULT_AUTOPOST_COUNT
} = {}) {
  const normalizedMode = normalizeAutopostMode(mode);
  const rankedRuns = Array.isArray(runs) ? runs.slice() : [];

  if (normalizedMode === AUTOPOST_MODES.FLIGHT_GROUPS) {
    return buildFlightSections(rankedRuns, 3);
  }

  if (normalizedMode === AUTOPOST_MODES.CATEGORY_GROUPS) {
    return buildCategorySections(rankedRuns, 3);
  }

  if (normalizedMode === AUTOPOST_MODES.FULL_BREAKDOWN) {
    return [
      buildSingleSection('overall', '🔥 Best Overall', rankedRuns.slice(0, 3)),
      ...buildFlightSections(rankedRuns, 3),
      ...buildCategorySections(rankedRuns, 3)
    ];
  }

  return [buildSingleSection('overall', '🔥 Best Overall', rankedRuns.slice(0, normalizeAutopostCount(count)))];
}

function parseAutopostListInput(value, {
  fieldLabel,
  validValues,
  resolveValue,
  strict = true
}) {
  const tokens = splitAutopostInput(value);
  const values = [];
  const invalid = [];
  const seen = new Set();

  for (const token of tokens) {
    const resolvedValue = resolveValue(token);

    if (!resolvedValue) {
      invalid.push(token);
      continue;
    }

    const uniqueKey = String(resolvedValue).toLowerCase();

    if (!seen.has(uniqueKey)) {
      seen.add(uniqueKey);
      values.push(resolvedValue);
    }
  }

  if (strict && invalid.length) {
    throw new Error(
      `Invalid ${fieldLabel}: ${invalid.join(', ')}. Valid options: ${validValues.join(', ')}.`
    );
  }

  return { values };
}

function splitAutopostInput(value) {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => splitAutopostInput(entry));
  }

  return String(value || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function buildSingleSection(key, title, runs) {
  return {
    key,
    title,
    runs
  };
}

function buildFlightSections(sortedRuns, limit) {
  return FLIGHT_GROUPS.map((group) =>
    buildSingleSection(
      group.key,
      group.title,
      sortedRuns.filter((run) => getFlightGroupForRun(run)?.key === group.key).slice(0, limit)
    )
  );
}

function buildCategorySections(sortedRuns, limit) {
  return CATEGORY_GROUPS.map((group) =>
    buildSingleSection(
      group.key,
      group.title,
      sortedRuns
        .filter((run) => getTrackedRunCategory(run?.itemName) === group.key)
        .slice(0, limit)
    )
  );
}

module.exports = {
  AUTOPOST_MODE_CHOICES,
  AUTOPOST_MODES,
  CATEGORY_GROUPS,
  DEFAULT_AUTOPOST_COUNT,
  FLIGHT_GROUPS,
  MAX_AUTOPOST_COUNT,
  MIN_AUTOPOST_COUNT,
  buildAutopostDescription,
  buildAutopostEmptyDescription,
  buildAutopostEmptyTitle,
  buildAutopostSections,
  buildAutopostTitle,
  formatAutopostFilters,
  formatAutopostMode,
  formatAutopostModeSummary,
  getFlightGroupForRun,
  normalizeAutopostCount,
  normalizeAutopostFilters,
  normalizeAutopostMode,
  parseAutopostCategoryInput,
  parseAutopostCountryInput
};
