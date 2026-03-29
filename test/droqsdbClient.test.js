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

test('run-universe filtering uses the defined selection helper without crashing', async () => {
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
        isProjectedViable: true
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
  assert.equal(payload.runs[0].itemName, 'Xanax');
  assert.deepEqual(payload.countries, ['Canada']);
  assert.deepEqual(payload.categories, ['drugs']);
});
