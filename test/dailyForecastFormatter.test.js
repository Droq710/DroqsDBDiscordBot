const assert = require('node:assert/strict');
const test = require('node:test');

const { buildDailyForecastEmbed } = require('../src/utils/formatters');

function createForecastItem(index, overrides = {}) {
  return {
    rank: index,
    itemName: `Item ${index}`,
    country: 'Japan',
    profitPerItem: 1000 + index,
    profitPerMinute: 100 + index,
    confidence: index % 2 === 0 ? 'medium' : 'high',
    confidencePercent: 80,
    bestSafetyMarginMinutes: 20,
    flyOutWindows: [
      {
        leaveAt: '2026-04-28T09:30:00.000Z',
        leaveAtTct: '09:30 TCT',
        leaveWindowEndAt: '2026-04-28T10:30:00.000Z',
        leaveWindowEndAtTct: '10:30 TCT',
        availability: 'projected_on_arrival',
        reason: 'Predicted restock before arrival with sufficient learned stock window.'
      },
      {
        leaveAt: '2026-04-28T12:45:00.000Z',
        leaveAtTct: '12:45 TCT',
        leaveWindowEndAt: '2026-04-28T13:45:00.000Z',
        leaveWindowEndAtTct: '13:45 TCT',
        availability: 'projected_on_arrival'
      }
    ],
    ...overrides
  };
}

test('daily forecast embed formats the top 10 items and caps fly-out windows', () => {
  const forecast = {
    generatedAt: '2026-04-28T08:00:00.000Z',
    horizonHours: 24,
    items: Array.from({ length: 12 }, (_entry, index) =>
      createForecastItem(index + 1, {
        flyOutWindows: Array.from({ length: 7 }, (_window, windowIndex) => ({
          leaveAtTct: `${String(9 + windowIndex).padStart(2, '0')}:00 TCT`,
          leaveWindowEndAtTct: `${String(9 + windowIndex).padStart(2, '0')}:30 TCT`,
          availability: 'projected_on_arrival',
          tightWindow: windowIndex === 0
        }))
      })
    )
  };

  const json = buildDailyForecastEmbed({
    forecast,
    count: 10,
    url: 'https://droqsdb.example.test'
  }).toJSON();

  assert.equal(json.title, '📅 DroqsDB Daily Travel Forecast');
  assert.match(json.description, /Forecasts are estimates based on current data/);
  assert.equal(json.fields.length, 10);
  assert.match(json.fields[0].name, /#1 Item 1 - Japan/);
  assert.match(json.fields[0].value, /Profit\/item: \$1,001\.00/);
  assert.match(json.fields[0].value, /Fly-out times:/);
  assert.match(json.fields[0].value, /\+2 more/);
  assert.doesNotMatch(json.fields.map((field) => field.name).join('\n'), /Item 11/);
  assert.match(json.footer.text, /Source: DroqsDB Public API \| Generated 2026-04-28 08:00 TCT/);
});

test('daily forecast embed renders a clean empty state', () => {
  const json = buildDailyForecastEmbed({
    forecast: {
      generatedAt: '2026-04-28T08:00:00.000Z',
      horizonHours: 24,
      items: []
    },
    url: 'https://droqsdb.example.test'
  }).toJSON();

  assert.equal(json.fields.length, 1);
  assert.equal(json.fields[0].name, 'No Forecast Opportunities');
  assert.match(json.fields[0].value, /did not return any qualified daily forecast items/);
  assert.match(json.footer.text, /Generated 2026-04-28 08:00 TCT/);
});
