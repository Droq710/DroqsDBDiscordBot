const assert = require('node:assert/strict');
const test = require('node:test');

const { DroqsDbClient } = require('../src/api/droqsdbClient');

function createCache() {
  return {
    getStale() {
      return null;
    },
    async getOrSet(_key, factory) {
      return factory();
    }
  };
}

function createLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {}
  };
}

test('run-universe filtering keeps live runs separate from guided departures', async () => {
  const client = new DroqsDbClient({
    baseUrl: 'https://api.example.test',
    webBaseUrl: 'https://droqsdb.example.test',
    cache: createCache(),
    logger: createLogger()
  });

  client.getTopRuns = async () => ({
    generatedAt: '2026-03-29T12:00:00.000Z',
    apiPath: '/api/top-profits',
    runCount: 2,
    emptyStateGuidance: null,
    runs: [
      {
        itemName: 'Xanax',
        country: 'Canada',
        trackedCategory: 'drugs',
        profitPerMinute: 120000,
        stock: 0,
        availabilityState: 'projected_on_arrival',
        departInMinutes: 12,
        isProjectedViable: true
      },
      {
        itemName: 'Vicodin',
        country: 'Canada',
        trackedCategory: 'drugs',
        profitPerMinute: 90000,
        stock: 8,
        isCurrentlyInStock: true
      },
      {
        itemName: 'Red Rose',
        country: 'Mexico',
        trackedCategory: 'flowers',
        profitPerMinute: 90000,
        isCurrentlyInStock: true
      }
    ]
  });

  const payload = await client.getCurrentRunUniverseForFilters({
    countries: ['Canada'],
    categories: ['drugs']
  });

  assert.equal(payload.runs.length, 1);
  assert.equal(payload.runs[0].itemName, 'Vicodin');
  assert.equal(payload.guidedRuns.length, 1);
  assert.equal(payload.guidedRuns[0].itemName, 'Xanax');
  assert.deepEqual(payload.countries, ['Canada']);
  assert.deepEqual(payload.categories, ['drugs']);
});

test('filtered current-run lookups prefer live runs and keep planner departures as fallback guidance', async () => {
  const client = new DroqsDbClient({
    baseUrl: 'https://api.example.test',
    webBaseUrl: 'https://droqsdb.example.test',
    cache: createCache(),
    logger: createLogger()
  });

  client.queryTravelPlanner = async () => ({
    generatedAt: '2026-03-29T12:00:00.000Z',
    apiPath: '/api/companion/v1/travel-planner/query',
    emptyStateGuidance: null,
    runs: [
      {
        itemName: 'Xanax',
        country: 'Canada',
        category: 'drugs',
        profitPerMinute: 120000,
        stock: 0,
        availabilityState: 'projected_on_arrival',
        departInMinutes: 15,
        isProjectedViable: true
      },
      {
        itemName: 'Ecstasy',
        country: 'Mexico',
        category: 'drugs',
        profitPerMinute: 80000,
        stock: 7,
        isCurrentlyInStock: true
      }
    ]
  });

  const payload = await client.getCurrentRunsForFilters({
    count: 1,
    categories: ['drugs']
  });

  assert.equal(payload.runs.length, 1);
  assert.equal(payload.runs[0].itemName, 'Ecstasy');
  assert.equal(payload.guidedRuns.length, 1);
  assert.equal(payload.guidedRuns[0].itemName, 'Xanax');
});

test('travel planner queries use the bot fixed 19/private profile by default', async () => {
  const client = new DroqsDbClient({
    baseUrl: 'https://api.example.test',
    webBaseUrl: 'https://droqsdb.example.test',
    cache: createCache(),
    logger: createLogger()
  });
  let capturedRequest = null;

  client.requestJson = async (pathname, options) => {
    capturedRequest = {
      pathname,
      options
    };

    return {
      generatedAt: '2026-03-29T12:00:00.000Z',
      runs: [],
      emptyStateGuidance: null
    };
  };

  await client.queryTravelPlanner({
    countries: ['Canada'],
    limit: 2
  });

  const requestBody = JSON.parse(capturedRequest.options.body);

  assert.equal(capturedRequest.pathname, '/api/companion/v1/travel-planner/query');
  assert.deepEqual(requestBody.settings, {
    sellWhere: 'market',
    applyTax: true,
    flightType: 'private',
    capacity: 19
  });
  assert.deepEqual(requestBody.filters.countries, ['Canada']);
  assert.equal(requestBody.limit, 2);
});

test('daily forecast lookup uses the public daily-forecast endpoint and normalizes items', async () => {
  const client = new DroqsDbClient({
    baseUrl: 'https://droqsdb.example.test/api/public/v1',
    webBaseUrl: 'https://droqsdb.example.test',
    cache: createCache(),
    logger: createLogger()
  });
  let capturedPathname = null;

  client.requestJson = async (pathname) => {
    capturedPathname = pathname;

    return {
      generatedAt: '2026-04-28T08:00:00.000Z',
      items: [
        {
          rank: 1,
          itemName: 'Xanax',
          country: 'Japan',
          profitPerItem: '123456',
          profitPerMinute: '1234.5',
          confidence: 'High',
          confidencePercent: '91',
          flyOutWindows: [
            {
              leaveAtTct: '09:30 TCT',
              leaveWindowEndAtTct: '10:30 TCT',
              availability: 'Projected On Arrival',
              tightWindow: true
            }
          ]
        },
        {
          itemName: '',
          country: 'Japan'
        }
      ],
      warnings: ['sample warning']
    };
  };

  const payload = await client.getDailyForecast();

  assert.equal(capturedPathname, 'daily-forecast');
  assert.equal(payload.apiPath, '/api/public/v1/daily-forecast');
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].itemName, 'Xanax');
  assert.equal(payload.items[0].profitPerItem, 123456);
  assert.equal(payload.items[0].confidence, 'high');
  assert.equal(payload.items[0].flyOutWindows[0].availability, 'projected on arrival');
  assert.deepEqual(payload.warnings, ['sample warning']);
});

test('market sell-target lookups use the planner instead of top-profits defaults', async () => {
  const client = new DroqsDbClient({
    baseUrl: 'https://api.example.test',
    webBaseUrl: 'https://droqsdb.example.test',
    cache: createCache(),
    logger: createLogger()
  });
  let capturedSettings = null;

  client.queryTravelPlanner = async (options) => {
    capturedSettings = options.settings;

    return {
      generatedAt: '2026-03-29T12:00:00.000Z',
      apiPath: '/api/companion/v1/travel-planner/query',
      emptyStateGuidance: null,
      runs: [
        {
          itemName: 'Xanax',
          country: 'Canada',
          profitPerMinute: 120000,
          stock: 9,
          isCurrentlyInStock: true
        }
      ]
    };
  };
  client.getTopRuns = async () => {
    throw new Error('getTopRuns should not be used for market sell-target lookups.');
  };

  const payload = await client.getCurrentRunsForSellTarget('market', 1);

  assert.deepEqual(capturedSettings, {
    sellWhere: 'market'
  });
  assert.equal(payload.apiPath, '/api/companion/v1/travel-planner/query');
  assert.equal(payload.runs.length, 1);
  assert.equal(payload.runs[0].itemName, 'Xanax');
});
