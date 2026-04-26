const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MAX_GIVEAWAY_DURATION_MS,
  parseGiveawayDuration
} = require('../src/utils/giveaway');

test('giveaway duration accepts up to 30 days', () => {
  const duration = parseGiveawayDuration('30d');

  assert.equal(duration.durationMs, 30 * 24 * 60 * 60 * 1000);
  assert.equal(duration.durationMs, MAX_GIVEAWAY_DURATION_MS);
  assert.equal(duration.normalized, '30d');
});

test('giveaway duration rejects values above 30 days', () => {
  assert.throws(
    () => parseGiveawayDuration('30d1m'),
    /cannot be longer than 30 days/
  );
});
