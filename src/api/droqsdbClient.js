const {
  getDefaultTrackedRoundTripHours,
  getTrackedRunCategory,
  matchesTrackedRunCategory,
  normalizeTrackedRunCategory,
  resolveTrackedCountryName
} = require('../constants/droqsdb');

const COMPANION_TRAVEL_PLANNER_QUERY_PATH = '/api/companion/v1/travel-planner/query';
const DEFAULT_DROQSDB_API_TIMEOUT_MS = 30_000;
const DEFAULT_TRAVEL_PLANNER_RESULT_LIMIT = 10;
const MAX_TRAVEL_PLANNER_RESULT_LIMIT = 100;
const DEFAULT_COMPANION_TRAVEL_PLANNER_SETTINGS = Object.freeze({
  sellWhere: 'market',
  applyTax: true,
  flightType: 'standard',
  capacity: 29
});

function normalizeText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function isCurrentProfitableRun(row) {
  return Number(row?.stock) > 0 && Number(row?.profitPerMinute) > 0;
}

function sortByProfitPerMinuteDesc(left, right) {
  return Number(right?.profitPerMinute || 0) - Number(left?.profitPerMinute || 0);
}

class DroqsDbApiError extends Error {
  constructor(
    message,
    {
      status = 500,
      code = 'API_ERROR',
      details = null,
      retryable = false,
      upstreamUnavailable = false
    } = {}
  ) {
    super(message);
    this.name = 'DroqsDbApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryable = retryable;
    this.upstreamUnavailable = upstreamUnavailable;
  }
}

class DroqsDbLookupError extends Error {
  constructor(message, { suggestions = [] } = {}) {
    super(message);
    this.name = 'DroqsDbLookupError';
    this.suggestions = suggestions;
  }
}

class DroqsDbClient {
  constructor({
    baseUrl,
    webBaseUrl,
    cache,
    logger = console,
    defaultTtlMs = 30_000,
    defaultStaleTtlMs = 120_000,
    requestTimeoutMs = DEFAULT_DROQSDB_API_TIMEOUT_MS
  }) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.webBaseUrl = String(webBaseUrl || '').replace(/\/+$/, '');
    this.cache = cache;
    this.logger = logger;
    this.defaultTtlMs = defaultTtlMs;
    this.defaultStaleTtlMs = defaultStaleTtlMs;
    this.requestTimeoutMs = resolveRequestTimeoutMs(requestTimeoutMs);
  }

  buildApiUrl(pathname) {
    const normalized = String(pathname || '').replace(/^\/+/, '');
    return `${this.baseUrl}/${normalized}`;
  }

  buildApiPath(pathname) {
    const basePath = this.baseUrl.replace(/^https?:\/\/[^/]+/i, '');
    const normalized = String(pathname || '').replace(/^\/+/, '');
    return `${basePath}/${normalized}`;
  }

  buildWebUrl(pathname) {
    const normalized = String(pathname || '').replace(/^\/+/, '');
    return `${this.webBaseUrl}/${normalized}`;
  }

  async requestJson(
    pathname,
    {
      ttlMs = this.defaultTtlMs,
      staleTtlMs = this.defaultStaleTtlMs,
      method = 'GET',
      headers = {},
      body = undefined,
      urlOverride = null
    } = {}
  ) {
    const normalizedMethod = String(method || 'GET').trim().toUpperCase() || 'GET';
    const url = urlOverride || this.buildApiUrl(pathname);
    const cacheKey = buildRequestCacheKey({
      method: normalizedMethod,
      url,
      body
    });
    const stalePayload = this.cache.getStale(cacheKey);

    return this.cache.getOrSet(
      cacheKey,
      async () => {
        const startedAt = Date.now();
        let response;

        try {
          response = await fetch(url, {
            method: normalizedMethod,
            headers: {
              Accept: 'application/json',
              ...headers
            },
            body,
            signal:
              this.requestTimeoutMs > 0 && typeof AbortSignal?.timeout === 'function'
                ? AbortSignal.timeout(this.requestTimeoutMs)
                : undefined
          });
        } catch (error) {
          const requestError = normalizeFetchError(error);

          if (stalePayload !== null) {
            this.logger.warn('droqsdb.request.stale_fallback', requestError, {
              pathname,
              url,
              method: normalizedMethod,
              durationMs: Date.now() - startedAt
            });
            return stalePayload;
          }

          throw requestError;
        }

        let rawBody = '';

        try {
          rawBody = await response.text();
        } catch (error) {
          const responseError = new DroqsDbApiError('DroqsDB response could not be read.', {
            status: response.status || 502,
            code: 'RESPONSE_READ_FAILED',
            details: {
              pathname,
              url
            },
            retryable: isRetryableStatus(response.status),
            upstreamUnavailable: isRetryableStatus(response.status)
          });

          if (stalePayload !== null && responseError.retryable) {
            this.logger.warn('droqsdb.request.stale_fallback', responseError, {
              pathname,
              url,
              method: normalizedMethod,
              durationMs: Date.now() - startedAt
            });
            return stalePayload;
          }

          throw responseError;
        }

        let payload = null;

        if (rawBody) {
          try {
            payload = JSON.parse(rawBody);
          } catch (error) {
            const parseError = new DroqsDbApiError('DroqsDB returned invalid JSON.', {
              status: response.status,
              code: 'INVALID_JSON',
              details: rawBody,
              retryable: isRetryableStatus(response.status),
              upstreamUnavailable: isRetryableStatus(response.status)
            });

            if (stalePayload !== null && parseError.retryable) {
              this.logger.warn('droqsdb.request.stale_fallback', parseError, {
                pathname,
                url,
                method: normalizedMethod,
                durationMs: Date.now() - startedAt
              });
              return stalePayload;
            }

            throw parseError;
          }
        }

        if (!response.ok || payload?.ok === false) {
          const apiError = new DroqsDbApiError(payload?.message || 'DroqsDB request failed.', {
            status: response.status,
            code: payload?.code || 'API_ERROR',
            details: payload,
            retryable: isRetryableStatus(response.status),
            upstreamUnavailable: isRetryableStatus(response.status)
          });

          if (stalePayload !== null && apiError.retryable) {
            this.logger.warn('droqsdb.request.stale_fallback', apiError, {
              pathname,
              url,
              method: normalizedMethod,
              durationMs: Date.now() - startedAt
            });
            return stalePayload;
          }

          throw apiError;
        }

        this.logger.debug('droqsdb.request.success', {
          pathname,
          url,
          method: normalizedMethod,
          durationMs: Date.now() - startedAt
        });

        return payload;
      },
      {
        ttlMs,
        staleTtlMs
      }
    );
  }

  async getMeta() {
    const payload = await this.requestJson('meta', { ttlMs: 60_000 });
    return {
      ...payload,
      apiPath: this.buildApiPath('meta')
    };
  }

  async getTopRuns() {
    const payload = await this.requestJson('top-profits');
    return {
      ...payload,
      apiPath: this.buildApiPath('top-profits'),
      items: Array.isArray(payload.items) ? payload.items : [],
      runCount: normalizePositiveInteger(payload.runCount, 0),
      runs: normalizePublicRunArray(payload.runs),
      emptyStateGuidance: normalizeEmptyStateGuidance(payload?.emptyStateGuidance)
    };
  }

  async getCountries() {
    const payload = await this.requestJson('countries', { ttlMs: 60_000 });
    return {
      ...payload,
      apiPath: this.buildApiPath('countries'),
      countries: Array.isArray(payload.countries) ? payload.countries : []
    };
  }

  async getCountry(countryInput) {
    const countryName = await this.resolveCountryName(countryInput);
    const payload = await this.requestJson(`country/${encodeURIComponent(countryName)}`);

    return {
      ...payload,
      requestedCountry: countryName,
      apiPath: this.buildApiPath(`country/${encodeURIComponent(countryName)}`),
      country: payload.country || { country: countryName, items: [] },
      emptyStateGuidance: normalizeEmptyStateGuidance(payload?.emptyStateGuidance)
    };
  }

  async getItemsIndex() {
    const payload = await this.requestJson('items', { ttlMs: 60_000 });
    return {
      ...payload,
      apiPath: this.buildApiPath('items'),
      items: Array.isArray(payload.items) ? payload.items : []
    };
  }

  async getExport() {
    const payload = await this.requestJson('export');
    return {
      ...payload,
      apiPath: this.buildApiPath('export'),
      countries: Array.isArray(payload.countries) ? payload.countries : [],
      emptyStateGuidance: normalizeEmptyStateGuidance(payload?.emptyStateGuidance)
    };
  }

  async getTravelPlannerDefaultSettings() {
    try {
      const meta = await this.getMeta();
      return normalizeTravelPlannerSettings(meta?.api?.defaultProfitSettings);
    } catch (error) {
      return {
        ...DEFAULT_COMPANION_TRAVEL_PLANNER_SETTINGS
      };
    }
  }

  async queryTravelPlanner({
    countries = [],
    categories = [],
    itemNames = [],
    limit = 1,
    roundTripHours = getDefaultTrackedRoundTripHours(),
    settings = null
  } = {}) {
    const requestBody = {
      settings: normalizeTravelPlannerSettings(settings || (await this.getTravelPlannerDefaultSettings())),
      filters: {
        roundTripHours: normalizeRoundTripHours(roundTripHours),
        countries: normalizeStringArray(countries),
        categories: normalizeStringArray(categories).map((category) => this.resolveCategory(category)),
        itemNames: normalizeStringArray(itemNames)
      },
      limit: normalizePositiveInteger(limit, 1)
    };
    const payload = await this.requestJson(COMPANION_TRAVEL_PLANNER_QUERY_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody),
      urlOverride: this.buildWebUrl(COMPANION_TRAVEL_PLANNER_QUERY_PATH)
    });
    const normalizedBestRun = normalizePublicRun(payload?.bestRun);
    const bestRun =
      normalizedBestRun && isViablePublicRun(normalizedBestRun) ? normalizedBestRun : null;

    return {
      ...payload,
      apiPath: COMPANION_TRAVEL_PLANNER_QUERY_PATH,
      bestRun,
      runs: normalizePublicRunArray(payload?.runs) || [],
      emptyReason: String(payload?.emptyReason || '').trim() || null,
      emptyStateGuidance: normalizeEmptyStateGuidance(payload?.emptyStateGuidance)
    };
  }

  async getRunEmptyStateGuidance({
    country = null,
    category = null,
    itemName = null
  } = {}) {
    const payload = await this.queryTravelPlanner({
      countries: country ? [country] : [],
      categories: category ? [category] : [],
      itemNames: itemName ? [itemName] : [],
      limit: 1
    });

    return {
      generatedAt: payload.generatedAt || null,
      apiPath: payload.apiPath,
      emptyReason: payload.emptyReason,
      emptyStateGuidance: payload.emptyStateGuidance
    };
  }

  async resolveCountryName(countryInput) {
    const countriesPayload = await this.getCountries();
    const localMatch = resolveTrackedCountryName(countryInput);
    const requested = normalizeText(localMatch || countryInput);
    const match = countriesPayload.countries.find(
      (country) => normalizeText(country.country) === requested
    );

    if (!match) {
      const suggestions = countriesPayload.countries.map((country) => country.country).slice(0, 10);
      throw new DroqsDbLookupError(`Country "${countryInput}" is not supported by the DroqsDB API.`, {
        suggestions
      });
    }

    return match.country;
  }

  async resolveItemName(itemInput) {
    const itemsPayload = await this.getItemsIndex();
    const requested = normalizeText(itemInput);

    const exact = itemsPayload.items.find((item) => normalizeText(item.itemName) === requested);

    if (exact) {
      return exact.itemName;
    }

    const prefixMatches = itemsPayload.items.filter((item) =>
      normalizeText(item.itemName).startsWith(requested)
    );

    if (prefixMatches.length === 1) {
      return prefixMatches[0].itemName;
    }

    const containsMatches = itemsPayload.items.filter((item) =>
      normalizeText(item.itemName).includes(requested)
    );

    if (containsMatches.length === 1) {
      return containsMatches[0].itemName;
    }

    const suggestions = (prefixMatches.length ? prefixMatches : containsMatches)
      .slice(0, 10)
      .map((item) => item.itemName);

    if (suggestions.length) {
      throw new DroqsDbLookupError(`Item "${itemInput}" was not an exact match.`, {
        suggestions
      });
    }

    throw new DroqsDbLookupError(`Item "${itemInput}" was not found in the DroqsDB API.`);
  }

  async getItem(itemInput) {
    let resolvedItemName;
    let payload;

    try {
      resolvedItemName = await this.resolveItemName(itemInput);
      payload = await this.requestJson(`item/${encodeURIComponent(resolvedItemName)}`);
    } catch (error) {
      if (!(error instanceof DroqsDbLookupError)) {
        throw error;
      }

      try {
        payload = await this.requestJson(`item/${encodeURIComponent(itemInput)}`);
        resolvedItemName = payload?.item?.itemName || String(itemInput).trim();
      } catch (directLookupError) {
        if (
          directLookupError instanceof DroqsDbApiError &&
          (directLookupError.status === 404 || directLookupError.code === 'ITEM_NOT_FOUND')
        ) {
          throw error;
        }

        throw directLookupError;
      }
    }

    return {
      ...payload,
      requestedItemName: itemInput,
      resolvedItemName,
      apiPath: this.buildApiPath(`item/${encodeURIComponent(resolvedItemName)}`),
      item: payload.item || { itemName: resolvedItemName, countries: [] },
      emptyStateGuidance: normalizeEmptyStateGuidance(payload?.emptyStateGuidance)
    };
  }

  async suggestItems(query, limit = 25) {
    const itemsPayload = await this.getItemsIndex();
    const requested = normalizeText(query);

    if (!requested) {
      return itemsPayload.items
        .slice()
        .sort((left, right) => Number(right.bestProfitPerMinute || 0) - Number(left.bestProfitPerMinute || 0))
        .slice(0, limit)
        .map((item) => item.itemName);
    }

    return itemsPayload.items
      .map((item) => ({
        itemName: item.itemName,
        matchScore: this.scoreItemSuggestion(item.itemName, requested),
        bestProfitPerMinute: Number(item.bestProfitPerMinute || 0)
      }))
      .filter((item) => item.matchScore > 0)
      .sort((left, right) => {
        if (right.matchScore !== left.matchScore) {
          return right.matchScore - left.matchScore;
        }

        return right.bestProfitPerMinute - left.bestProfitPerMinute;
      })
      .slice(0, limit)
      .map((item) => item.itemName);
  }

  scoreItemSuggestion(itemName, requested) {
    const normalizedItemName = normalizeText(itemName);

    if (normalizedItemName === requested) {
      return 100;
    }

    if (normalizedItemName.startsWith(requested)) {
      return 75;
    }

    if (normalizedItemName.includes(requested)) {
      return 50;
    }

    return 0;
  }

  resolveCategory(categoryInput) {
    const validCategory = normalizeTrackedRunCategory(categoryInput);

    if (!validCategory) {
      throw new DroqsDbLookupError(`Category "${categoryInput}" is not supported.`, {
        suggestions: ['plushies', 'flowers', 'drugs']
      });
    }

    return validCategory;
  }

  async getCurrentRunsForSellTarget(targetInput, count = 10) {
    const sellTarget = normalizeSellTarget(targetInput);

    if (!sellTarget) {
      throw new DroqsDbLookupError(`Sell target "${targetInput}" is not supported.`, {
        suggestions: ['market', 'bazaar', 'torn']
      });
    }

    if (sellTarget === 'market') {
      const payload = await this.getTopRuns();

      return {
        generatedAt: payload.generatedAt,
        apiPath: payload.apiPath,
        sellTarget,
        emptyStateGuidance: payload.emptyStateGuidance || null,
        runs: getTopRunsForDisplay(payload).slice(0, normalizeSliceCount(count))
      };
    }

    try {
      const settings = await this.getTravelPlannerDefaultSettings();
      const payload = await this.queryTravelPlanner({
        settings: {
          ...settings,
          sellWhere: sellTarget
        },
        limit: normalizeTravelPlannerLimit(count, DEFAULT_TRAVEL_PLANNER_RESULT_LIMIT)
      });

      return {
        generatedAt: payload.generatedAt,
        apiPath: payload.apiPath,
        sellTarget,
        emptyStateGuidance: payload.emptyStateGuidance || null,
        runs: payload.runs.slice(0, normalizeSliceCount(count))
      };
    } catch (error) {
      this.logger.warn('droqsdb.travel_planner.sell_target_fallback', error, {
        sellTarget
      });

      const payload = await this.getTopRuns();

      return {
        generatedAt: payload.generatedAt,
        apiPath: payload.apiPath,
        sellTarget,
        emptyStateGuidance: payload.emptyStateGuidance || null,
        runs: getTopRunsForDisplay(payload)
          .filter((run) => hasSellTargetPrice(run, sellTarget))
          .slice(0, normalizeSliceCount(count))
      };
    }
  }

  async getCurrentRunsByCountry(countryInput, count = 10) {
    const countryName = await this.resolveCountryName(countryInput);

    return this.getCurrentRunsForFilters({
      count,
      countries: [countryName]
    });
  }

  async getCurrentRunsByItem(itemInput, count = 3) {
    const payload = await this.getItem(itemInput);
    let generatedAt = payload.generatedAt;
    let apiPath = payload.apiPath;
    let emptyStateGuidance = payload.emptyStateGuidance || null;
    let currentRuns;

    try {
      const plannerPayload = await this.queryTravelPlanner({
        itemNames: [payload.resolvedItemName],
        limit: normalizeTravelPlannerLimit(count, 3)
      });

      generatedAt = plannerPayload.generatedAt || generatedAt;
      apiPath = plannerPayload.apiPath || apiPath;
      emptyStateGuidance = plannerPayload.emptyStateGuidance || emptyStateGuidance;
      currentRuns = plannerPayload.runs.slice(0, normalizeSliceCount(count));
    } catch (error) {
      this.logger.warn('droqsdb.travel_planner.item_fallback', error, {
        itemName: payload.resolvedItemName
      });

      currentRuns = buildLegacyCurrentRunsFromItemPayload(payload).slice(0, normalizeSliceCount(count));
    }

    const restockableRuns = (payload.item.countries || [])
      .filter((country) => Number(country.stock) <= 0 && Number.isFinite(Number(country.estimatedRestockMinutes)))
      .sort((left, right) => Number(left.estimatedRestockMinutes || 0) - Number(right.estimatedRestockMinutes || 0));

    return {
      generatedAt,
      apiPath,
      item: payload.item,
      emptyStateGuidance,
      currentRuns,
      restockableRuns
    };
  }

  async getCurrentRunsForFilters({
    count = 10,
    countries = [],
    categories = [],
    country = null,
    category = null
  } = {}) {
    const requestedCount = normalizeTravelPlannerLimit(count, DEFAULT_TRAVEL_PLANNER_RESULT_LIMIT);
    const filters = normalizeRunFilterSelections({
      countries,
      categories,
      country,
      category
    });

    try {
      const payload = await this.queryTravelPlanner({
        countries: filters.countries,
        categories: filters.categories,
        limit: requestedCount
      });

      return buildRunFilterResult({
        generatedAt: payload.generatedAt,
        apiPath: payload.apiPath,
        countries: filters.countries,
        categories: filters.categories,
        emptyStateGuidance: payload.emptyStateGuidance || null,
        runs: payload.runs
      });
    } catch (error) {
      this.logger.warn('droqsdb.travel_planner.filters_fallback', error, {
        countries: filters.countries,
        categories: filters.categories
      });

      const payload = await this.getLegacyCurrentRunUniverseForFilters(filters);

      return {
        ...payload,
        runs: payload.runs.slice(0, requestedCount)
      };
    }
  }

  async getCurrentRunUniverseForFilters({
    countries = [],
    categories = [],
    country = null,
    category = null
  } = {}) {
    const filters = normalizeRunFilterSelections({
      countries,
      categories,
      country,
      category
    });
    try {
      const payload = await this.queryTravelPlanner({
        countries: filters.countries,
        categories: filters.categories,
        limit: MAX_TRAVEL_PLANNER_RESULT_LIMIT
      });

      return buildRunFilterResult({
        generatedAt: payload.generatedAt,
        apiPath: payload.apiPath,
        countries: filters.countries,
        categories: filters.categories,
        emptyStateGuidance: payload.emptyStateGuidance || null,
        runs: payload.runs
      });
    } catch (error) {
      this.logger.warn('droqsdb.travel_planner.universe_fallback', error, {
        countries: filters.countries,
        categories: filters.categories
      });

      return this.getLegacyCurrentRunUniverseForFilters(filters);
    }
  }

  async getCurrentRunsByCategory(categoryInput, count = 10) {
    const validCategory = this.resolveCategory(categoryInput);

    return this.getCurrentRunsForFilters({
      count,
      categories: [validCategory]
    });
  }

  async getLegacyCurrentRunsByCountry(countryInput, count = 10) {
    const payload = await this.getCountry(countryInput);
    const runs = buildCurrentRunsFromCountryPayload(payload).slice(0, normalizeSliceCount(count));

    return buildRunFilterResult({
      generatedAt: payload.generatedAt,
      apiPath: payload.apiPath,
      countries: [payload.country.country],
      categories: [],
      emptyStateGuidance: payload.emptyStateGuidance || null,
      runs
    });
  }

  async getLegacyCurrentRunUniverseForFilters({
    countries = [],
    categories = []
  } = {}) {
    const filters = normalizeRunFilterSelections({
      countries,
      categories
    });

    const topRunsPayload = await this.getTopRuns();
    const filteredPublicRuns =
      topRunsPayload.runs !== null
        ? safeFilterRunsForSelections(topRunsPayload.runs, filters)
        : null;
    const hasExplicitFilters = filters.countries.length > 0 || filters.categories.length > 0;
    const publicRunsMayBeTruncated =
      topRunsPayload.runs !== null &&
      normalizePositiveInteger(topRunsPayload.runCount, 0) > topRunsPayload.runs.length;

    if (
      topRunsPayload.runs !== null &&
      (!hasExplicitFilters || filteredPublicRuns.length > 0 || !publicRunsMayBeTruncated)
    ) {
      return buildRunFilterResult({
        generatedAt: topRunsPayload.generatedAt,
        apiPath: topRunsPayload.apiPath,
        countries: filters.countries,
        categories: filters.categories,
        emptyStateGuidance: topRunsPayload.emptyStateGuidance || null,
        runs: filteredPublicRuns
      });
    }

    if (filters.countries.length === 1 && !filters.categories.length) {
      return this.getLegacyCurrentRunsByCountry(filters.countries[0], null);
    }

    if (!filters.countries.length && filters.categories.length === 1) {
      return this.getLegacyCurrentRunsByCategory(filters.categories[0], null);
    }

    if (filters.countries.length === 1) {
      const payload = await this.getCountry(filters.countries[0]);

      return buildRunFilterResult({
        generatedAt: payload.generatedAt,
        apiPath: payload.apiPath,
        countries: [payload.country.country],
        categories: filters.categories,
        runs: filterCurrentRunsForSelections(buildCurrentRunsFromCountryPayload(payload), filters)
      });
    }

    const payload = await this.getExport();

    return buildRunFilterResult({
      generatedAt: payload.generatedAt,
      apiPath: payload.apiPath,
      countries: filters.countries,
      categories: filters.categories,
      runs: filterCurrentRunsForSelections(buildCurrentRunsFromExportPayload(payload), filters)
    });
  }

  async getLegacyCurrentRunsByCategory(categoryInput, count = 10) {
    const validCategory = this.resolveCategory(categoryInput);
    const payload = await this.getExport();
    const runs = filterCurrentRunsForSelections(buildCurrentRunsFromExportPayload(payload), {
      countries: [],
      categories: [validCategory]
    }).slice(0, normalizeSliceCount(count));

    return buildRunFilterResult({
      generatedAt: payload.generatedAt,
      apiPath: payload.apiPath,
      countries: [],
      categories: [validCategory],
      runs
    });
  }

  matchesNamedCategory(itemName, category) {
    return matchesTrackedRunCategory(itemName, category);
  }

  async getItemCountrySnapshot(itemInput, countryInput) {
    const payload = await this.getItem(itemInput);
    const countryName = await this.resolveCountryName(countryInput);
    const countryRow = (payload.item.countries || []).find(
      (country) => normalizeText(country.country) === normalizeText(countryName)
    );

    return {
      generatedAt: payload.generatedAt,
      apiPath: payload.apiPath,
      item: payload.item,
      country: countryName,
      countryRow: countryRow || null
    };
  }
}

module.exports = {
  DroqsDbApiError,
  DroqsDbClient,
  DroqsDbLookupError
};

function buildRequestCacheKey({
  method,
  url,
  body
}) {
  return `${String(method || 'GET').toUpperCase()}:${url}:${body || ''}`;
}

function isRetryableStatus(status) {
  return [408, 425, 429, 500, 502, 503, 504].includes(Number(status));
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveRequestTimeoutMs(requestTimeoutMs) {
  const envTimeoutMs = normalizePositiveInteger(process.env.DROQSDB_API_TIMEOUT_MS, null);

  if (envTimeoutMs !== null) {
    return envTimeoutMs;
  }

  return normalizePositiveInteger(requestTimeoutMs, DEFAULT_DROQSDB_API_TIMEOUT_MS);
}

function normalizeSliceCount(count) {
  const parsed = Number.parseInt(count, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : Number.MAX_SAFE_INTEGER;
}

function normalizeTravelPlannerLimit(limit, fallback = DEFAULT_TRAVEL_PLANNER_RESULT_LIMIT) {
  const parsed = Number.parseInt(limit, 10);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(MAX_TRAVEL_PLANNER_RESULT_LIMIT, parsed);
}

function toSelectionArray(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (value === null || value === undefined) {
    return [];
  }

  return [value];
}

function normalizeStringArray(values) {
  return Array.isArray(values)
    ? values
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    : [];
}

function normalizeResolvedSelectionArray(values, resolveValue) {
  const normalized = [];
  const seen = new Set();

  for (const value of normalizeStringArray(toSelectionArray(values))) {
    const resolvedValue = resolveValue(value);

    if (!resolvedValue) {
      continue;
    }

    const key = normalizeText(resolvedValue);

    if (!seen.has(key)) {
      seen.add(key);
      normalized.push(resolvedValue);
    }
  }

  return normalized;
}

function normalizeRunFilterSelections({
  countries = [],
  categories = [],
  country = null,
  category = null
} = {}) {
  return {
    countries: normalizeResolvedSelectionArray(
      [...toSelectionArray(countries), ...toSelectionArray(country)],
      resolveTrackedCountryName
    ),
    categories: normalizeResolvedSelectionArray(
      [...toSelectionArray(categories), ...toSelectionArray(category)],
      normalizeTrackedRunCategory
    )
  };
}

function buildRunFilterResult({
  generatedAt,
  apiPath,
  countries = [],
  categories = [],
  emptyStateGuidance = null,
  runs = []
}) {
  const filters = normalizeRunFilterSelections({
    countries,
    categories
  });

  return {
    generatedAt,
    apiPath,
    country: filters.countries.length === 1 ? filters.countries[0] : null,
    category: filters.categories.length === 1 ? filters.categories[0] : null,
    countries: filters.countries,
    categories: filters.categories,
    emptyStateGuidance,
    runs
  };
}

function buildCurrentRunsFromCountryPayload(payload) {
  return (payload?.country?.items || [])
    .filter(isCurrentProfitableRun)
    .map((item) => ({
      ...item,
      country: payload.country.country
    }))
    .sort(sortByProfitPerMinuteDesc);
}

function buildCurrentRunsFromExportPayload(payload) {
  const runs = [];

  for (const countryRow of payload?.countries || []) {
    for (const item of countryRow.items || []) {
      if (!isCurrentProfitableRun(item)) {
        continue;
      }

      runs.push({
        ...item,
        country: countryRow.country
      });
    }
  }

  runs.sort(sortByProfitPerMinuteDesc);
  return runs;
}

function safeFilterRunsForSelections(runs, filters = {}) {
  const selectionFilter = resolveRunSelectionFilter();

  if (!selectionFilter) {
    return Array.isArray(runs) ? runs.slice() : [];
  }

  return selectionFilter(runs, filters);
}

function resolveRunSelectionFilter() {
  if (typeof filterRunsForSelections === 'function') {
    return filterRunsForSelections;
  }

  if (typeof filterRunsForSelection === 'function') {
    return filterRunsForSelection;
  }

  return null;
}

function filterRunsForSelections(runs, filters = {}) {
  return applyRunSelectionFilter(runs, filters);
}

function filterRunsForSelection(runs, filters = {}) {
  return filterRunsForSelections(runs, filters);
}

function filterCurrentRunsForSelections(runs, {
  countries = [],
  categories = []
} = {}) {
  return applyRunSelectionFilter(runs, {
    countries,
    categories
  });
}

function applyRunSelectionFilter(runs, {
  countries = [],
  categories = []
} = {}) {
  const normalizedRuns = Array.isArray(runs) ? runs : [];
  const countrySet = countries.length
    ? new Set(countries.map((country) => normalizeText(country)))
    : null;
  const categorySet = categories.length
    ? new Set(categories.map((category) => normalizeText(category)))
    : null;

  return normalizedRuns.filter((run) => {
    if (countrySet && !countrySet.has(normalizeText(run?.country))) {
      return false;
    }

    if (!categorySet) {
      return true;
    }

    const trackedCategory =
      normalizeTrackedRunCategory(run?.trackedCategory) || getTrackedRunCategory(run?.itemName);
    return trackedCategory ? categorySet.has(normalizeText(trackedCategory)) : false;
  });
}

function normalizeRoundTripHours(value) {
  const numeric = Number(value);

  if (!Number.isFinite(numeric) || numeric <= 0) {
    return getDefaultTrackedRoundTripHours();
  }

  return Math.max(0.5, Math.round(numeric * 2) / 2);
}

function normalizeSellTarget(value) {
  const normalized = normalizeText(value);
  return ['market', 'bazaar', 'torn'].includes(normalized) ? normalized : null;
}

function normalizeTravelPlannerSettings(settings) {
  const source = settings && typeof settings === 'object' ? settings : {};
  const normalizedCapacity = Number.parseInt(source.capacity, 10);

  return {
    sellWhere: String(source.sellWhere || DEFAULT_COMPANION_TRAVEL_PLANNER_SETTINGS.sellWhere)
      .trim()
      .toLowerCase() || DEFAULT_COMPANION_TRAVEL_PLANNER_SETTINGS.sellWhere,
    applyTax:
      typeof source.applyTax === 'boolean'
        ? source.applyTax
        : DEFAULT_COMPANION_TRAVEL_PLANNER_SETTINGS.applyTax,
    flightType: String(source.flightType || DEFAULT_COMPANION_TRAVEL_PLANNER_SETTINGS.flightType)
      .trim()
      .toLowerCase() || DEFAULT_COMPANION_TRAVEL_PLANNER_SETTINGS.flightType,
    capacity:
      Number.isInteger(normalizedCapacity) && normalizedCapacity > 0
        ? normalizedCapacity
        : DEFAULT_COMPANION_TRAVEL_PLANNER_SETTINGS.capacity
  };
}

function normalizeEmptyStateGuidance(guidance) {
  if (!guidance || typeof guidance !== 'object') {
    return null;
  }

  const kind = normalizeText(guidance.kind || guidance.type);

  if (!kind) {
    return null;
  }

  const asMetric = (value) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  };

  return {
    kind,
    type: normalizeText(guidance.type || kind) || kind,
    itemName: String(guidance.itemName || '').trim() || null,
    country: String(guidance.country || '').trim() || null,
    reasonCode: String(guidance.reasonCode || '').trim() || null,
    messageShort:
      String(guidance.messageShort || guidance.message || '').trim() || null,
    messageDetailed:
      String(guidance.messageDetailed || guidance.message || '').trim() || null,
    message:
      String(guidance.messageDetailed || guidance.messageShort || guidance.message || '').trim() ||
      null,
    runKind: String(guidance.runKind || '').trim() || null,
    departureMinutes: asMetric(guidance.departureMinutes ?? guidance.departInMinutes),
    departInMinutes: asMetric(guidance.departInMinutes ?? guidance.departureMinutes),
    departureAt: guidance.departureAt || null,
    departAtTct: String(guidance.departAtTct || '').trim() || null,
    arrivalAt: guidance.arrivalAt || null,
    restockAt: guidance.restockAt || null,
    stockoutAt: guidance.stockoutAt || null,
    viableWindowDurationMinutes: asMetric(
      guidance.viableWindowDurationMinutes ?? guidance.availabilityWindowMinutes
    ),
    availabilityWindowMinutes: asMetric(
      guidance.availabilityWindowMinutes ?? guidance.viableWindowDurationMinutes
    ),
    arrivalBufferMinutes: asMetric(guidance.arrivalBufferMinutes),
    tightWindow: guidance.tightWindow === true || guidance.timingTight === true,
    timingTight: guidance.timingTight === true || guidance.tightWindow === true
  };
}

function normalizePublicRunArray(runs) {
  if (!Array.isArray(runs)) {
    return null;
  }

  return runs
    .map((run) => normalizePublicRun(run))
    .filter(Boolean)
    .filter((run) => isViablePublicRun(run));
}

function normalizePublicRun(run) {
  if (!run || typeof run !== 'object') {
    return null;
  }

  const itemName = String(run.itemName || '').trim();
  const country = String(run.country || '').trim();

  if (!itemName || !country) {
    return null;
  }

  const trackedCategory =
    normalizeTrackedRunCategory(run.category) || getTrackedRunCategory(itemName);
  const availabilityState = normalizeText(run.availabilityState) || null;
  const isCurrentlyInStock =
    typeof run.isCurrentlyInStock === 'boolean' ? run.isCurrentlyInStock : Number(run.stock) > 0;
  const isProjectedViable =
    typeof run.isProjectedViable === 'boolean'
      ? run.isProjectedViable
      : availabilityState === 'projected_on_arrival';

  return {
    ...run,
    itemName,
    country,
    category: String(run.category || run.shopCategory || '').trim() || null,
    shopCategory: String(run.shopCategory || '').trim() || null,
    trackedCategory,
    availabilityState,
    isCurrentlyInStock,
    isProjectedViable,
    departInMinutes: toMetric(run.departInMinutes),
    availabilityWindowMinutes: toMetric(run.availabilityWindowMinutes),
    restockEtaMinutes: toMetric(run.restockEtaMinutes),
    stockUpdatedAt: run.stockUpdatedAt || run.updatedAt || null,
    pricingSource: String(run.pricingSource || run.source || '').trim() || null,
    pricingUpdatedAt: run.pricingUpdatedAt || run.updatedAt || null,
    timingTight: run.timingTight === true
  };
}

function isViablePublicRun(run) {
  if (Number(run?.profitPerMinute) <= 0) {
    return false;
  }

  if (run?.isProjectedViable === true) {
    return true;
  }

  if (run?.isCurrentlyInStock === true) {
    return true;
  }

  return normalizeText(run?.availabilityState) === 'in_stock';
}

function toMetric(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function getTopRunsForDisplay(payload) {
  if (Array.isArray(payload?.runs)) {
    return payload.runs;
  }

  return Array.isArray(payload?.items) ? payload.items : [];
}

function hasSellTargetPrice(run, sellTarget) {
  switch (sellTarget) {
    case 'market':
      return Number(run?.profitPerMinute) > 0;
    case 'bazaar':
      return Number(run?.bazaarPrice) > 0;
    case 'torn':
      return Number(run?.tornCityShops) > 0;
    default:
      return false;
  }
}

function buildLegacyCurrentRunsFromItemPayload(payload) {
  return (payload.item.countries || []).filter(isCurrentProfitableRun).sort(sortByProfitPerMinuteDesc);
}

function normalizeFetchError(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return new DroqsDbApiError('DroqsDB API request timed out.', {
      status: 504,
      code: 'API_TIMEOUT',
      details: {
        cause: error.message
      },
      retryable: true,
      upstreamUnavailable: true
    });
  }

  return new DroqsDbApiError('DroqsDB API is temporarily unavailable.', {
    status: 503,
    code: 'UPSTREAM_UNAVAILABLE',
    details: {
      cause: error?.message || String(error)
    },
    retryable: true,
    upstreamUnavailable: true
  });
}
