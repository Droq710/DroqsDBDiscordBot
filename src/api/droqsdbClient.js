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
    ].map((item) => item.toLowerCase())
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
    ].map((item) => item.toLowerCase())
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
    ].map((item) => item.toLowerCase())
  )
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

  async requestJson(
    pathname,
    {
      ttlMs = this.defaultTtlMs,
      staleTtlMs = this.defaultStaleTtlMs
    } = {}
  ) {
    const url = this.buildApiUrl(pathname);
    const stalePayload = this.cache.getStale(url);

    return this.cache.getOrSet(
      url,
      async () => {
        const startedAt = Date.now();
        let response;

        try {
          response = await fetch(url, {
            headers: {
              Accept: 'application/json'
            },
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
              durationMs: Date.now() - startedAt
            });
            return stalePayload;
          }

          throw apiError;
        }

        this.logger.debug('droqsdb.request.success', {
          pathname,
          url,
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
    const validCategory = Object.prototype.hasOwnProperty.call(CATEGORY_ITEM_NAMES, requestedCategory)
      ? requestedCategory
      : null;

    if (!validCategory) {
      throw new DroqsDbLookupError(`Category "${categoryInput}" is not supported.`, {
        suggestions: Object.keys(CATEGORY_ITEM_NAMES)
      });
    }

    return validCategory;
  }

  async getCurrentRunsByCountry(countryInput, count = 10) {
    const payload = await this.getCountry(countryInput);
    const runs = (payload.country.items || [])
      .filter(isCurrentProfitableRun)
      .sort(sortByProfitPerMinuteDesc)
      .slice(0, count);

    return {
      generatedAt: payload.generatedAt,
      apiPath: payload.apiPath,
      country: payload.country.country,
      runs
    };
  }

  async getCurrentRunsByItem(itemInput, count = 3) {
    const payload = await this.getItem(itemInput);
    const currentRuns = (payload.item.countries || [])
      .filter(isCurrentProfitableRun)
      .sort(sortByProfitPerMinuteDesc)
      .slice(0, count);

    const restockableRuns = (payload.item.countries || [])
      .filter((country) => Number(country.stock) <= 0 && Number.isFinite(Number(country.estimatedRestockMinutes)))
      .sort((left, right) => Number(left.estimatedRestockMinutes || 0) - Number(right.estimatedRestockMinutes || 0));

    return {
      generatedAt: payload.generatedAt,
      apiPath: payload.apiPath,
      item: payload.item,
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
      runs: runs.slice(0, count)
    };
  }

  matchesNamedCategory(itemName, category) {
    const itemSet = CATEGORY_ITEM_NAMES[category];
    return itemSet ? itemSet.has(normalizeText(itemName)) : false;
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

function isRetryableStatus(status) {
  return [408, 425, 429, 500, 502, 503, 504].includes(Number(status));
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
