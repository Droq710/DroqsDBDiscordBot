const assert = require('node:assert/strict');
const test = require('node:test');

const { resolveGiveawayGame } = require('../src/services/giveawayGames');

test('standard giveaways still draw multiple winners normally', () => {
  const result = resolveGiveawayGame({
    gameType: 'standard',
    entrantIds: ['user-1', 'user-2', 'user-3'],
    winnerCount: 2,
    randomIntFn: createSequenceRandom([2, 0])
  });

  assert.equal(result.gameType, 'standard');
  assert.deepEqual(result.winnerIds, ['user-3', 'user-1']);
  assert.equal(result.detailLines.length, 0);
});

test('Russian Roulette standard alternates shots until one player survives', () => {
  const result = resolveGiveawayGame({
    gameType: 'russian_roulette_standard',
    entrantIds: ['user-1', 'user-2'],
    randomIntFn: createSequenceRandom([0, 2])
  });

  assert.deepEqual(result.participantIds, ['user-1', 'user-2']);
  assert.deepEqual(result.winnerIds, ['user-2']);
  assert.match(result.summaryLine, /user-2/);
  assert.deepEqual(result.detailLines, [
    'Players: <@user-1> vs <@user-2>',
    '1. <@user-1> pulls the trigger... click.',
    '2. <@user-2> pulls the trigger... click.',
    '3. <@user-1> pulls the trigger... BANG.'
  ]);
});

test('Russian Roulette extreme leaves only the safe chamber survivor', () => {
  const result = resolveGiveawayGame({
    gameType: 'russian_roulette_extreme',
    entrantIds: ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'],
    randomIntFn: createSequenceRandom([0, 0, 0, 0, 0, 4])
  });

  assert.deepEqual(result.winnerIds, ['u5']);
  assert.match(result.summaryLine, /u5/);
  assert.match(result.detailLines.join('\n'), /safe chamber/);
});

test('Dice Duel rerolls ties and awards the higher roll', () => {
  const result = resolveGiveawayGame({
    gameType: 'dice_duel',
    entrantIds: ['u1', 'u2'],
    randomIntFn: createSequenceRandom([0, 49, 49, 19, 88])
  });

  assert.deepEqual(result.winnerIds, ['u2']);
  assert.equal(result.detailLines.length, 3);
  assert.match(result.detailLines[1], /Tie, rolling again/);
  assert.match(result.summaryLine, /89/);
});

test('Double or Nothing busts into a fallback draw when the risk roll fails', () => {
  const result = resolveGiveawayGame({
    gameType: 'double_or_nothing',
    entrantIds: ['u1', 'u2', 'u3'],
    randomIntFn: createSequenceRandom([1, 1, 9])
  });

  assert.deepEqual(result.participantIds, ['u2', 'u3']);
  assert.deepEqual(result.winnerIds, ['u3']);
  assert.match(result.summaryLine, /busted/);
});

test('Last Man Standing randomly eliminates entrants until one remains', () => {
  const result = resolveGiveawayGame({
    gameType: 'last_man_standing',
    entrantIds: ['u1', 'u2', 'u3', 'u4'],
    randomIntFn: createSequenceRandom([1, 2, 0])
  });

  assert.deepEqual(result.winnerIds, ['u3']);
  assert.match(result.summaryLine, /last one standing/);
  assert.match(result.detailLines.join('\n'), /Eliminated|Final fall/);
});

test('Slot Machine evaluates spins and picks the best roll', () => {
  const result = resolveGiveawayGame({
    gameType: 'slot_machine',
    entrantIds: ['u1', 'u2', 'u3'],
    randomIntFn: createSequenceRandom([0, 0, 0, 0, 0, 0, 1, 1, 2, 5, 4, 3])
  });

  assert.deepEqual(result.winnerIds, ['u1']);
  assert.match(result.summaryLine, /machine/);
  assert.match(result.detailLines.join('\n'), /JACKPOT/);
});

test('Coin Flip Battle resolves as a best-of-three set', () => {
  const result = resolveGiveawayGame({
    gameType: 'coin_flip_battle',
    entrantIds: ['u1', 'u2'],
    randomIntFn: createSequenceRandom([0, 0, 1, 0])
  });

  assert.deepEqual(result.winnerIds, ['u1']);
  assert.match(result.summaryLine, /2-1/);
  assert.equal(result.detailLines.length, 4);
});

test('Risk Run scores checkpoints and awards the highest banked total', () => {
  const result = resolveGiveawayGame({
    gameType: 'risk_run',
    entrantIds: ['u1', 'u2', 'u3', 'u4'],
    randomIntFn: createSequenceRandom([0, 0, 0, 89, 19, 89, 89, 19, 89, 89, 89, 9])
  });

  assert.deepEqual(result.winnerIds, ['u3']);
  assert.match(result.summaryLine, /7 point/);
  assert.match(result.detailLines.join('\n'), /Final Sprint \+4 \(90\)/);
});

function createSequenceRandom(values) {
  const queue = Array.isArray(values) ? values.slice() : [];

  return (maxExclusive) => {
    if (!queue.length) {
      throw new Error(`Missing deterministic random value for range ${maxExclusive}`);
    }

    const nextValue = queue.shift();

    if (!Number.isInteger(nextValue) || nextValue < 0 || nextValue >= maxExclusive) {
      throw new Error(
        `Deterministic random value ${nextValue} is out of range for ${maxExclusive}`
      );
    }

    return nextValue;
  };
}
