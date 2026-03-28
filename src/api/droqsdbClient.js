const {
  getDefaultTrackedRoundTripHours,
  matchesTrackedRunCategory
} = require('../constants/droqsdb');

const COMPANION_TRAVEL_PLANNER_QUERY_PATH = '/api/companion/v1/travel-planner/query';
const DEFAULT_COMPANION_TRAVEL_PLANNER_SETTINGS = Object.freeze({
  sellWhere: 'market',
  applyTax: true,
  flightType: 'standard',
  capacity: 29
});

const COUNTRY_ALIASES = Object.freeze({
  uk: 'United Kingdom',
  uae: 'UAE',
  cayman: 'Cayman Islands',
  caymans: 'Cayman Islands',
  sa: 'South Africa'
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
    requestTimeoutMs = 8_000
  }) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.webBaseUrl = String(webBaseUrl || '').replace(/\/+$/, '');
    this.cache = cache;
    this.logger = logger;
    this.defaultTtlMs = defaultTtlMs;
    this.defaultStaleTtlMs = defaultStaleTtlMs;
    this.requestTimeoutMs = requestTimeoutMs;
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
      items: Array.isArray(payload.items) ? payload.items : []
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
      country: payload.country || { country: countryName, items: [] }
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
      countries: Array.isArray(payload.countries) ? payload.countries : []
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

    return {
      ...payload,
      apiPath: COMPANION_TRAVEL_PLANNER_QUERY_PATH,
      bestRun: payload?.bestRun || null,
      runs: Array.isArray(payload?.runs) ? payload.runs : [],
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
    const alias = COUNTRY_ALIASES[normalizeText(countryInput)];
    const requested = normalizeText(alias || countryInput);
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
      item: payload.item || { itemName: resolvedItemName, countries: [] }
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
    const requestedCategory = normalizeText(categoryInput);
    const validCategory = ['plushies', 'flowers', 'drugs'].includes(requestedCategory)
      ? requestedCategory
      : null;

    if (!validCategory) {
      throw new DroqsDbLookupError(`Category "${categoryInput}" is not supported.`, {
        suggestions: ['plushies', 'flowers', 'drugs']
      });
    }

    return validCategory;
  }

  async getCurrentRunsByCountry(countryInput, count = 10) {
    const payload = await this.getCountry(countryInput);
    const runs = (payload.country.items || [])
      .filter(isCurrentProfitableRun)
      .map((item) => ({
        ...item,
        country: payload.country.country
      }))
      .sort(sortByProfitPerMinuteDesc)
      .slice(0, normalizeSliceCount(count));

    return {
      generatedAt: payload.generatedAt,
      apiPath: payload.apiPath,
      country: payload.country.country,
      emptyStateGuidance: payload.emptyStateGuidance || null,
      runs
    };
  }

  async getCurrentRunsByItem(itemInput, count = 3) {
    const payload = await this.getItem(itemInput);
    const currentRuns = (payload.item.countries || [])
      .filter(isCurrentProfitableRun)
      .sort(sortByProfitPerMinuteDesc)
      .slice(0, normalizeSliceCount(count));

    const restockableRuns = (payload.item.countries || [])
      .filter((country) => Number(country.stock) <= 0 && Number.isFinite(Number(country.estimatedRestockMinutes)))
      .sort((left, right) => Number(left.estimatedRestockMinutes || 0) - Number(right.estimatedRestockMinutes || 0));

    return {
      generatedAt: payload.generatedAt,
      apiPath: payload.apiPath,
      item: payload.item,
      emptyStateGuidance: payload.emptyStateGuidance || null,
      currentRuns,
      restockableRuns
    };
  }

  async getCurrentRunsForFilters({
    count = 10,
    country = null,
    category = null
  } = {}) {
    const requestedCount = Number.parseInt(count, 10) || 10;
    const requestedCountry = typeof country === 'string' && country.trim() ? country.trim() : null;
    const requestedCategory =
      typeof category === 'string' && category.trim()
        ? this.resolveCategory(category)
        : null;

    if (requestedCountry && requestedCategory) {
      const payload = await this.getCountry(requestedCountry);
      const runs = (payload.country.items || [])
        .filter(isCurrentProfitableRun)
        .filter((item) => this.matchesNamedCategory(item.itemName, requestedCategory))
        .map((item) => ({
          ...item,
          country: payload.country.country
        }))
        .sort(sortByProfitPerMinuteDesc)
        .slice(0, requestedCount);

      return {
        generatedAt: payload.generatedAt,
        apiPath: payload.apiPath,
        country: payload.country.country,
        category: requestedCategory,
        runs
      };
    }

    if (requestedCountry) {
      const payload = await this.getCurrentRunsByCountry(requestedCountry, requestedCount);
      return {
        ...payload,
        category: null
      };
    }

    if (requestedCategory) {
      const payload = await this.getCurrentRunsByCategory(requestedCategory, requestedCount);
      return {
        ...payload,
        country: null
      };
    }

    const payload = await this.getTopRuns();

    return {
      generatedAt: payload.generatedAt,
      apiPath: payload.apiPath,
      country: null,
      category: null,
      runs: payload.items.slice(0, requestedCount)
    };
  }

  async getCurrentRunUniverseForFilters({
    country = null,
    category = null
  } = {}) {
    const requestedCountry = typeof country === 'string' && country.trim() ? country.trim() : null;
    const requestedCategory =
      typeof category === 'string' && category.trim()
        ? this.resolveCategory(category)
        : null;

    if (requestedCountry && requestedCategory) {
      const payload = await this.getCountry(requestedCountry);
      const runs = (payload.country.items || [])
        .filter(isCurrentProfitableRun)
        .filter((item) => this.matchesNamedCategory(item.itemName, requestedCategory))
        .map((item) => ({
          ...item,
          country: payload.country.country
        }))
        .sort(sortByProfitPerMinuteDesc);

      return {
        generatedAt: payload.generatedAt,
        apiPath: payload.apiPath,
        country: payload.country.country,
        category: requestedCategory,
        runs
      };
    }

    if (requestedCountry) {
      return this.getCurrentRunsByCountry(requestedCountry, null);
    }

    if (requestedCategory) {
      return this.getCurrentRunsByCategory(requestedCategory, null);
    }

    const payload = await this.getExport();
    const runs = [];

    for (const countryRow of payload.countries) {
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

    return {
      generatedAt: payload.generatedAt,
      apiPath: payload.apiPath,
      country: null,
      category: null,
      runs
    };
  }

  async getCurrentRunsByCategory(categoryInput, count = 10) {
    const validCategory = this.resolveCategory(categoryInput);
    const payload = await this.getExport();
    const runs = [];

    for (const country of payload.countries) {
      for (const item of country.items || []) {
        if (!this.matchesNamedCategory(item.itemName, validCategory)) {
          continue;
        }

        if (!isCurrentProfitableRun(item)) {
          continue;
        }

        runs.push({
          ...item,
          country: country.country
        });
      }
    }

    runs.sort(sortByProfitPerMinuteDesc);

    return {
      generatedAt: payload.generatedAt,
      apiPath: payload.apiPath,
      category: validCategory,
      runs: runs.slice(0, normalizeSliceCount(count))
    };
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

function normalizeSliceCount(count) {
  const parsed = Number.parseInt(count, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : Number.MAX_SAFE_INTEGER;
}

function normalizeStringArray(values) {
  return Array.isArray(values)
    ? values
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    : [];
}

function normalizeRoundTripHours(value) {
  const numeric = Number(value);

  if (!Number.isFinite(numeric) || numeric <= 0) {
    return getDefaultTrackedRoundTripHours();
  }

  return Math.max(0.5, Math.round(numeric * 2) / 2);
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

  const kind = String(guidance.kind || '').trim();

  if (!kind) {
    return null;
  }

  const asMetric = (value) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  };

  return {
    kind,
    itemName: String(guidance.itemName || '').trim() || null,
    country: String(guidance.country || '').trim() || null,
    reasonCode: String(guidance.reasonCode || '').trim() || null,
    message: String(guidance.message || '').trim() || null,
    runKind: String(guidance.runKind || '').trim() || null,
    departureMinutes: asMetric(guidance.departureMinutes),
    departureAt: guidance.departureAt || null,
    arrivalAt: guidance.arrivalAt || null,
    restockAt: guidance.restockAt || null,
    stockoutAt: guidance.stockoutAt || null,
    viableWindowDurationMinutes: asMetric(guidance.viableWindowDurationMinutes),
    arrivalBufferMinutes: asMetric(guidance.arrivalBufferMinutes),
    tightWindow: guidance.tightWindow === true
  };
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
