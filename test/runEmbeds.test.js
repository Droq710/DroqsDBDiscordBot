const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildBestRunEmbed,
  buildRunListEmbed
} = require('../src/utils/runEmbeds');
const {
  BOT_RUN_RESULTS_NOTE,
  buildRunEmptyStateGuidanceEmbed
} = require('../src/utils/formatters');

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

test('run list embeds highlight the higher sell price and move the fixed-profile disclaimer to a bottom note', () => {
  const embed = buildRunListEmbed({
    title: 'Top 1 Runs',
    description: 'Current profitable viable runs from DroqsDB.',
    runs: [createRun()],
    generatedAt: '2026-03-29T12:10:00.000Z',
    url: 'https://droqsdb.example.test'
  });
  const json = embed.toJSON();

  assert.equal(json.description, 'Current profitable viable runs from DroqsDB.');
  assert.equal(json.fields.length, 2);
  assert.match(
    json.fields[0].value,
    /Sell: Item Market: \$1,000,000\.00 \| \*\*Bazaar: \$1,100,000\.00\*\*/
  );
  assert.doesNotMatch(json.fields[0].value, /Buy:/);
  assert.doesNotMatch(json.fields[0].value, /Torn/);
  assert.equal(json.fields[1].value, `*${BOT_RUN_RESULTS_NOTE}*`);
});

test('single guided fallback runs render as a compact card instead of a one-item list', () => {
  const embed = buildRunListEmbed({
    title: 'Next Runs for Xanax',
    description: 'No profitable runs are live right now for this item. Showing the next available departure.',
    runs: [
      createRun({
        stock: 0,
        availabilityState: 'projected_on_arrival',
        isCurrentlyInStock: false,
        isProjectedViable: true,
        departInMinutes: 15,
        availabilityWindowMinutes: 20
      })
    ],
    generatedAt: '2026-03-29T12:10:00.000Z',
    url: 'https://droqsdb.example.test'
  });
  const json = embed.toJSON();

  assert.match(json.description, /\*\*Next best run:\*\* Xanax - Canada/);
  assert.match(json.description, /\*\*Timing:\*\* Leave in 15m \| Window 20m/);
  assert.match(
    json.description,
    /\*\*Profit:\*\* Profit\/min: \+\$123,456\.00 \| Profit\/item: \+\$654,321\.00/
  );
  assert.equal(json.fields.length, 1);
  assert.equal(json.fields[0].value, `*${BOT_RUN_RESULTS_NOTE}*`);
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
  assert.doesNotMatch(json.description, /Bot results use 19 carry capacity and private flight/);
  assert.equal(json.fields.at(-1).value, `*${BOT_RUN_RESULTS_NOTE}*`);
});

test('empty-state guidance embeds keep the older simple card feel and preserve source freshness', () => {
  const embed = buildRunEmptyStateGuidanceEmbed({
    title: 'No Current Runs for Xanax',
    fallbackDescription: 'No currently profitable viable runs are available for Xanax.',
    guidance: {
      kind: 'next_run',
      itemName: 'Xanax',
      country: 'Canada',
      departureMinutes: 15,
      departAtTct: '13:45',
      availabilityWindowMinutes: 20
    },
    generatedAt: '2026-03-29T12:10:00.000Z',
    sourceLabel: 'DroqsDB Companion API',
    url: 'https://droqsdb.example.test'
  });
  const json = embed.toJSON();

  assert.match(json.description, /\*\*Next best run:\*\* Xanax - Canada/);
  assert.match(json.description, /\*\*Timing:\*\* Leave in 15m \| 13:45 TCT \| Window ~20m/);
  assert.equal(json.fields.at(-1).value, `*${BOT_RUN_RESULTS_NOTE}*`);
  assert.match(json.footer.text, /Source: DroqsDB Companion API \| Generated 2026-03-29 12:10:00 UTC/);
});
