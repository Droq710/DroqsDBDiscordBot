const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildBestRunEmbed,
  buildRunListEmbed
} = require('../src/utils/runEmbeds');

function createRun(overrides = {}) {
  return {
    itemName: 'Xanax',
    country: 'Canada',
    category: 'drugs',
    stock: 12,
    profitPerMinute: 123456,
    profitPerItem: 654321,
    marketValue: 1000000,
    bazaarPrice: 1100000,
    tornCityShops: 900000,
    buyPrice: 750000,
    source: 'DroqsDB',
    pricingSource: 'DroqsDB',
    stockUpdatedAt: '2026-03-29T12:00:00.000Z',
    pricingUpdatedAt: '2026-03-29T12:05:00.000Z',
    ...overrides
  };
}

test('run list embeds highlight the higher sell price and include the fixed-profile disclaimer', () => {
  const embed = buildRunListEmbed({
    title: 'Top 1 Runs',
    description: 'Current profitable viable runs from DroqsDB.',
    runs: [
      createRun({
        availabilityState: 'projected_on_arrival',
        isProjectedViable: true,
        departInMinutes: 15
      })
    ],
    generatedAt: '2026-03-29T12:10:00.000Z',
    url: 'https://droqsdb.example.test'
  });
  const json = embed.toJSON();

  assert.match(
    json.description,
    /Bot results use 19 carry capacity and private flight\. For your own settings, use the site\./
  );
  assert.equal(json.fields.length, 1);
  assert.match(
    json.fields[0].value,
    /Sell: Item Market: \$1,000,000\.00 \| \*\*Bazaar: \$1,100,000\.00\*\*/
  );
  assert.match(json.fields[0].value, /Leave in 15m/);
  assert.doesNotMatch(json.fields[0].value, /Buy:/);
  assert.doesNotMatch(json.fields[0].value, /Torn/);
});

test('best run embeds keep single available sell prices unhighlighted and preserve bazaar unavailable text', () => {
  const embed = buildBestRunEmbed({
    run: createRun({
      bazaarPrice: null
    }),
    generatedAt: '2026-03-29T12:10:00.000Z',
    url: 'https://droqsdb.example.test'
  });
  const json = embed.toJSON();

  assert.equal(json.fields[0].name, 'Sell Prices');
  assert.match(json.fields[0].value, /Item Market: \$1,000,000\.00 \| Bazaar: Unavailable/);
  assert.doesNotMatch(json.fields[0].value, /\*\*Item Market/);
  assert.match(
    json.description,
    /Bot results use 19 carry capacity and private flight\. For your own settings, use the site\./
  );
});
