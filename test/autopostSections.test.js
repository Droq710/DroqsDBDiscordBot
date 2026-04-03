const assert = require('node:assert/strict');
const test = require('node:test');

const { AUTOPOST_MODES, buildAutopostSections } = require('../src/utils/autopost');

function createRun(overrides = {}) {
  return {
    itemName: 'Xanax',
    country: 'Canada',
    stock: 10,
    profitPerMinute: 100000,
    ...overrides
  };
}

test('full breakdown sections backfill with guided departures when live runs are missing', () => {
  const sections = buildAutopostSections({
    mode: AUTOPOST_MODES.FULL_BREAKDOWN,
    runs: [
      createRun({
        itemName: 'Xanax',
        country: 'Canada'
      })
    ],
    guidedRuns: [
      createRun({
        itemName: 'Vicodin',
        country: 'Mexico',
        stock: 0,
        departInMinutes: 12,
        isProjectedViable: true
      }),
      createRun({
        itemName: 'Red Rose',
        country: 'Argentina',
        stock: 0,
        departInMinutes: 28,
        isProjectedViable: true
      }),
      createRun({
        itemName: 'Jaguar Plushie',
        country: 'South Africa',
        stock: 0,
        departInMinutes: 40,
        isProjectedViable: true
      })
    ]
  });

  const overall = sections.find((section) => section.key === 'overall');
  const shortFlights = sections.find((section) => section.key === 'short');
  const mediumFlights = sections.find((section) => section.key === 'medium');
  const drugs = sections.find((section) => section.key === 'drugs');

  assert.equal(overall.runs.length, 3);
  assert.deepEqual(
    overall.runs.map((run) => run.itemName),
    ['Xanax', 'Vicodin', 'Red Rose']
  );
  assert.deepEqual(
    shortFlights.runs.map((run) => run.itemName),
    ['Xanax', 'Vicodin']
  );
  assert.deepEqual(
    mediumFlights.runs.map((run) => run.itemName),
    ['Red Rose']
  );
  assert.deepEqual(
    drugs.runs.map((run) => run.itemName),
    ['Xanax', 'Vicodin']
  );
});
