const { randomInt } = require('node:crypto');
const {
  GIVEAWAY_GAME_TYPE_COIN_FLIP_BATTLE,
  GIVEAWAY_GAME_TYPE_DICE_DUEL,
  GIVEAWAY_GAME_TYPE_DOUBLE_OR_NOTHING,
  GIVEAWAY_GAME_TYPE_LAST_MAN_STANDING,
  GIVEAWAY_GAME_TYPE_RISK_RUN,
  GIVEAWAY_GAME_TYPE_RUSSIAN_ROULETTE_EXTREME,
  GIVEAWAY_GAME_TYPE_RUSSIAN_ROULETTE_STANDARD,
  GIVEAWAY_GAME_TYPE_SLOT_MACHINE,
  GIVEAWAY_GAME_TYPE_STANDARD,
  getGiveawayGameTypeLabel,
  normalizeGiveawayGameType
} = require('../utils/giveaway');

const SLOT_SYMBOLS = Object.freeze([
  {
    label: '7',
    value: 6
  },
  {
    label: 'BAR',
    value: 5
  },
  {
    label: 'STAR',
    value: 4
  },
  {
    label: 'BELL',
    value: 3
  },
  {
    label: 'CHERRY',
    value: 2
  },
  {
    label: 'LEMON',
    value: 1
  }
]);
const RISK_RUN_STAGES = Object.freeze([
  {
    label: 'Dash',
    bustAtOrBelow: 15,
    points: 1
  },
  {
    label: 'Checkpoint',
    bustAtOrBelow: 35,
    points: 2
  },
  {
    label: 'Final Sprint',
    bustAtOrBelow: 55,
    points: 4
  }
]);

function resolveGiveawayGame({
  gameType = GIVEAWAY_GAME_TYPE_STANDARD,
  entrantIds = [],
  winnerCount = 1,
  randomIntFn = randomInt
} = {}) {
  const normalizedGameType = normalizeGiveawayGameType(gameType);
  const normalizedEntrants = normalizeIdList(entrantIds);

  switch (normalizedGameType) {
    case GIVEAWAY_GAME_TYPE_RUSSIAN_ROULETTE_STANDARD:
      return resolveRussianRouletteStandard(normalizedEntrants, randomIntFn);
    case GIVEAWAY_GAME_TYPE_RUSSIAN_ROULETTE_EXTREME:
      return resolveRussianRouletteExtreme(normalizedEntrants, randomIntFn);
    case GIVEAWAY_GAME_TYPE_DICE_DUEL:
      return resolveDiceDuel(normalizedEntrants, randomIntFn);
    case GIVEAWAY_GAME_TYPE_DOUBLE_OR_NOTHING:
      return resolveDoubleOrNothing(normalizedEntrants, randomIntFn);
    case GIVEAWAY_GAME_TYPE_LAST_MAN_STANDING:
      return resolveLastManStanding(normalizedEntrants, randomIntFn);
    case GIVEAWAY_GAME_TYPE_SLOT_MACHINE:
      return resolveSlotMachine(normalizedEntrants, randomIntFn);
    case GIVEAWAY_GAME_TYPE_COIN_FLIP_BATTLE:
      return resolveCoinFlipBattle(normalizedEntrants, randomIntFn);
    case GIVEAWAY_GAME_TYPE_RISK_RUN:
      return resolveRiskRun(normalizedEntrants, randomIntFn);
    case GIVEAWAY_GAME_TYPE_STANDARD:
    default:
      return buildResult({
        gameType: GIVEAWAY_GAME_TYPE_STANDARD,
        participantIds: normalizedEntrants,
        winnerIds: pickRandomEntries(
          normalizedEntrants,
          Math.max(0, Math.floor(Number(winnerCount) || 0)),
          randomIntFn
        )
      });
  }
}

function resolveRussianRouletteStandard(entrantIds, randomIntFn) {
  const participants = pickRandomEntries(entrantIds, 2, randomIntFn);

  if (participants.length < 2) {
    return buildInsufficientPlayersResult(
      GIVEAWAY_GAME_TYPE_RUSSIAN_ROULETTE_STANDARD,
      participants,
      'Only one eligible entrant remained, so the chamber was never needed.'
    );
  }

  const fatalShot = pickRandomNumber(1, 6, randomIntFn);
  const detailLines = [
    `Players: ${participants.map(formatUserMention).join(' vs ')}`
  ];
  let winnerId = participants[0];

  for (let shotIndex = 1; shotIndex <= fatalShot; shotIndex += 1) {
    const shooterId = participants[(shotIndex - 1) % participants.length];
    const isFatalShot = shotIndex === fatalShot;

    if (isFatalShot) {
      winnerId = participants[(shotIndex % participants.length)];
      detailLines.push(
        `${shotIndex}. ${formatUserMention(shooterId)} pulls the trigger... BANG.`
      );
      break;
    }

    detailLines.push(
      `${shotIndex}. ${formatUserMention(shooterId)} pulls the trigger... click.`
    );
  }

  return buildResult({
    gameType: GIVEAWAY_GAME_TYPE_RUSSIAN_ROULETTE_STANDARD,
    participantIds: participants,
    winnerIds: [winnerId],
    summaryLine: `${formatUserMention(winnerId)} survives the chamber.`,
    detailLines
  });
}

function resolveRussianRouletteExtreme(entrantIds, randomIntFn) {
  const participants = pickRandomEntries(
    entrantIds,
    Math.min(6, entrantIds.length),
    randomIntFn
  );

  if (participants.length < 2) {
    return buildInsufficientPlayersResult(
      GIVEAWAY_GAME_TYPE_RUSSIAN_ROULETTE_EXTREME,
      participants,
      'Only one eligible entrant remained, so the loaded chamber could not start.'
    );
  }

  const safeIndex = pickRandomIndex(participants.length, randomIntFn);
  const winnerId = participants[safeIndex];
  const detailLines = [
    `Finalists: ${participants.map(formatUserMention).join(', ')}`,
    `Loaded chamber: ${participants.length - 1} fatal round(s), 1 safe chamber.`
  ];

  participants.forEach((participantId, index) => {
    if (index === safeIndex) {
      detailLines.push(
        `${formatUserMention(participantId)} finds the only safe chamber and stays standing.`
      );
      return;
    }

    detailLines.push(
      `${formatUserMention(participantId)} pulls the trigger... BANG.`
    );
  });

  return buildResult({
    gameType: GIVEAWAY_GAME_TYPE_RUSSIAN_ROULETTE_EXTREME,
    participantIds: participants,
    winnerIds: [winnerId],
    summaryLine: `${formatUserMention(winnerId)} was the lone survivor.`,
    detailLines
  });
}

function resolveDiceDuel(entrantIds, randomIntFn) {
  const participants = pickRandomEntries(entrantIds, 2, randomIntFn);

  if (participants.length < 2) {
    return buildInsufficientPlayersResult(
      GIVEAWAY_GAME_TYPE_DICE_DUEL,
      participants,
      'Only one eligible entrant remained, so the duel auto-resolved.'
    );
  }

  const detailLines = [
    `Duelists: ${participants.map(formatUserMention).join(' vs ')}`
  ];
  let round = 1;
  let winnerId = participants[0];
  let winnerRoll = 0;

  while (true) {
    const leftRoll = pickRandomNumber(1, 100, randomIntFn);
    const rightRoll = pickRandomNumber(1, 100, randomIntFn);

    if (leftRoll === rightRoll) {
      detailLines.push(
        `Round ${round}: ${formatUserMention(participants[0])} rolled ${leftRoll}, ${formatUserMention(participants[1])} rolled ${rightRoll}. Tie, rolling again.`
      );
      round += 1;
      continue;
    }

    if (leftRoll > rightRoll) {
      winnerId = participants[0];
      winnerRoll = leftRoll;
    } else {
      winnerId = participants[1];
      winnerRoll = rightRoll;
    }

    detailLines.push(
      `Round ${round}: ${formatUserMention(participants[0])} rolled ${leftRoll}, ${formatUserMention(participants[1])} rolled ${rightRoll}.`
    );
    break;
  }

  return buildResult({
    gameType: GIVEAWAY_GAME_TYPE_DICE_DUEL,
    participantIds: participants,
    winnerIds: [winnerId],
    summaryLine: `${formatUserMention(winnerId)} wins the duel with ${winnerRoll}.`,
    detailLines
  });
}

function resolveDoubleOrNothing(entrantIds, randomIntFn) {
  const primaryDraw = pickRandomEntries(entrantIds, 1, randomIntFn);
  const primaryId = primaryDraw[0] || null;

  if (!primaryId) {
    return buildResult({
      gameType: GIVEAWAY_GAME_TYPE_DOUBLE_OR_NOTHING
    });
  }

  if (entrantIds.length < 2) {
    return buildInsufficientPlayersResult(
      GIVEAWAY_GAME_TYPE_DOUBLE_OR_NOTHING,
      [primaryId],
      'Only one eligible entrant remained, so they were handed the prize without the risk roll.'
    );
  }

  const backupId = pickRandomEntries(
    entrantIds.filter((entrantId) => entrantId !== primaryId),
    1,
    randomIntFn
  )[0];
  const riskRoll = pickRandomNumber(1, 100, randomIntFn);
  const primaryHeld = riskRoll >= 51;
  const winnerId = primaryHeld ? primaryId : backupId;

  return buildResult({
    gameType: GIVEAWAY_GAME_TYPE_DOUBLE_OR_NOTHING,
    participantIds: [primaryId, backupId].filter(Boolean),
    winnerIds: [winnerId],
    summaryLine: primaryHeld
      ? `${formatUserMention(primaryId)} held their nerve and kept the prize.`
      : `${formatUserMention(primaryId)} busted, so ${formatUserMention(
          backupId
        )} took the fallback draw.`,
    detailLines: [
      `Primary draw: ${formatUserMention(primaryId)}`,
      `Risk roll: ${riskRoll} / 100${primaryHeld ? ' - hold.' : ' - bust.'}`,
      primaryHeld
        ? `${formatUserMention(primaryId)} keeps the prize.`
        : `${formatUserMention(primaryId)} busts, and ${formatUserMention(
            backupId
          )} inherits the win.`
    ]
  });
}

function resolveLastManStanding(entrantIds, randomIntFn) {
  if (!entrantIds.length) {
    return buildResult({
      gameType: GIVEAWAY_GAME_TYPE_LAST_MAN_STANDING
    });
  }

  if (entrantIds.length === 1) {
    return buildInsufficientPlayersResult(
      GIVEAWAY_GAME_TYPE_LAST_MAN_STANDING,
      entrantIds,
      'Only one eligible entrant stepped into the arena.'
    );
  }

  const remaining = entrantIds.slice();
  const eliminations = [];

  while (remaining.length > 1) {
    eliminations.push(remaining.splice(pickRandomIndex(remaining.length, randomIntFn), 1)[0]);
  }

  const winnerId = remaining[0];
  const detailLines = [
    `Arena entrants: ${formatCount(entrantIds.length)}`
  ];

  if (eliminations.length <= 4) {
    detailLines.push(`Eliminated: ${eliminations.map(formatUserMention).join(', ')}`);
  } else {
    detailLines.push(
      `First drops: ${eliminations.slice(0, 3).map(formatUserMention).join(', ')}`
    );
    detailLines.push(`${formatCount(eliminations.length - 3)} more entrant(s) were knocked out.`);
    detailLines.push(
      `Final fall: ${formatUserMention(eliminations[eliminations.length - 1])}`
    );
  }

  return buildResult({
    gameType: GIVEAWAY_GAME_TYPE_LAST_MAN_STANDING,
    participantIds: entrantIds,
    winnerIds: [winnerId],
    summaryLine: `${formatUserMention(winnerId)} is the last one standing.`,
    detailLines
  });
}

function resolveSlotMachine(entrantIds, randomIntFn) {
  const participants = pickRandomEntries(
    entrantIds,
    Math.min(3, entrantIds.length),
    randomIntFn
  );

  if (participants.length < 2) {
    return buildInsufficientPlayersResult(
      GIVEAWAY_GAME_TYPE_SLOT_MACHINE,
      participants,
      'Only one eligible entrant reached the machine, so the reels never needed competition.'
    );
  }

  const detailLines = [
    participants.length < entrantIds.length
      ? `Finalists seeded from ${formatCount(entrantIds.length)} eligible entrant(s): ${participants.map(formatUserMention).join(', ')}`
      : `Finalists: ${participants.map(formatUserMention).join(', ')}`
  ];
  let round = 1;
  let contenders = participants.slice();
  let winningSpin = null;
  let winnerId = contenders[0];

  while (true) {
    const spins = contenders.map((participantId) => ({
      entrantId: participantId,
      spin: rollSlotSpin(randomIntFn)
    }));
    const prefix = round > 1 ? `Spin-off ${round}: ` : '';

    spins.forEach(({ entrantId, spin }) => {
      detailLines.push(
        `${prefix}${formatUserMention(entrantId)} -> [${spin.reels.join(' | ')}] ${spin.label}`
      );
    });

    const rankedSpins = spins.slice().sort((left, right) =>
      compareSlotSpinResults(right.spin, left.spin)
    );
    const topSpin = rankedSpins[0];
    const tiedSpins = rankedSpins.filter(
      ({ spin }) => compareSlotSpinResults(spin, topSpin.spin) === 0
    );

    if (tiedSpins.length === 1) {
      winnerId = topSpin.entrantId;
      winningSpin = topSpin.spin;
      break;
    }

    detailLines.push(
      `Tie on the machine: ${tiedSpins.map(({ entrantId }) => formatUserMention(entrantId)).join(', ')} spin again.`
    );
    contenders = tiedSpins.map(({ entrantId }) => entrantId);
    round += 1;
  }

  return buildResult({
    gameType: GIVEAWAY_GAME_TYPE_SLOT_MACHINE,
    participantIds: participants,
    winnerIds: [winnerId],
    summaryLine: `${formatUserMention(winnerId)} wins the machine with ${winningSpin.label.toLowerCase()}.`,
    detailLines
  });
}

function resolveCoinFlipBattle(entrantIds, randomIntFn) {
  const participants = pickRandomEntries(entrantIds, 2, randomIntFn);

  if (participants.length < 2) {
    return buildInsufficientPlayersResult(
      GIVEAWAY_GAME_TYPE_COIN_FLIP_BATTLE,
      participants,
      'Only one eligible entrant remained, so the coin battle never started.'
    );
  }

  const headsId = participants[0];
  const tailsId = participants[1];
  let headsScore = 0;
  let tailsScore = 0;
  const detailLines = [
    `${formatUserMention(headsId)} calls Heads. ${formatUserMention(
      tailsId
    )} takes Tails.`
  ];

  for (let round = 1; round <= 3; round += 1) {
    const flip = pickRandomIndex(2, randomIntFn) === 0 ? 'Heads' : 'Tails';

    if (flip === 'Heads') {
      headsScore += 1;
      detailLines.push(
        `Flip ${round}: Heads - ${formatUserMention(headsId)} scores.`
      );
    } else {
      tailsScore += 1;
      detailLines.push(
        `Flip ${round}: Tails - ${formatUserMention(tailsId)} scores.`
      );
    }

    if (headsScore === 2 || tailsScore === 2) {
      break;
    }
  }

  const winnerId = headsScore > tailsScore ? headsId : tailsId;

  return buildResult({
    gameType: GIVEAWAY_GAME_TYPE_COIN_FLIP_BATTLE,
    participantIds: participants,
    winnerIds: [winnerId],
    summaryLine: `${formatUserMention(winnerId)} wins the set ${headsScore}-${tailsScore}.`,
    detailLines
  });
}

function resolveRiskRun(entrantIds, randomIntFn) {
  const participants = pickRandomEntries(
    entrantIds,
    Math.min(4, entrantIds.length),
    randomIntFn
  );

  if (participants.length < 2) {
    return buildInsufficientPlayersResult(
      GIVEAWAY_GAME_TYPE_RISK_RUN,
      participants,
      'Only one eligible entrant made it to the course, so the run ended immediately.'
    );
  }

  const detailLines = [
    participants.length < entrantIds.length
      ? `Runners seeded from ${formatCount(entrantIds.length)} eligible entrant(s): ${participants.map(formatUserMention).join(', ')}`
      : `Runners: ${participants.map(formatUserMention).join(', ')}`
  ];
  let results = participants.map((participantId) =>
    buildRiskRunResult(participantId, randomIntFn)
  );

  results.forEach((result) => {
    detailLines.push(
      `${formatUserMention(result.entrantId)} -> ${result.stageSummary.join(', ')}. Total: ${result.points}`
    );
  });

  let rankedResults = results.slice().sort(compareRiskRunResults);
  let topResults = rankedResults.filter(
    (result) => compareRiskRunResults(result, rankedResults[0]) === 0
  );

  while (topResults.length > 1) {
    detailLines.push(
      `Tie on the run: ${topResults.map((result) => formatUserMention(result.entrantId)).join(', ')} sprint for the finish.`
    );
    const sprintResults = topResults.map((result) => ({
      entrantId: result.entrantId,
      sprintRoll: pickRandomNumber(1, 100, randomIntFn)
    }));

    detailLines.push(
      sprintResults
        .map(
          (result) =>
            `${formatUserMention(result.entrantId)} rolled ${result.sprintRoll}`
        )
        .join(' | ')
    );

    sprintResults.sort((left, right) => right.sprintRoll - left.sprintRoll);
    const topRoll = sprintResults[0].sprintRoll;
    const tiedSprintResults = sprintResults.filter(
      (result) => result.sprintRoll === topRoll
    );

    if (tiedSprintResults.length === 1) {
      topResults = [
        {
          entrantId: tiedSprintResults[0].entrantId
        }
      ];
      break;
    }

    topResults = tiedSprintResults.map((result) => ({
      entrantId: result.entrantId
    }));
  }

  const winnerId = topResults[0].entrantId;
  const winnerResult =
    results.find((result) => result.entrantId === winnerId) || results[0];

  return buildResult({
    gameType: GIVEAWAY_GAME_TYPE_RISK_RUN,
    participantIds: participants,
    winnerIds: [winnerId],
    summaryLine: `${formatUserMention(winnerId)} banked ${winnerResult.points} point(s) and won the run.`,
    detailLines
  });
}

function buildRiskRunResult(entrantId, randomIntFn) {
  const stageSummary = [];
  let points = 0;
  let clears = 0;
  let lastSafeRoll = 0;

  for (const stage of RISK_RUN_STAGES) {
    const roll = pickRandomNumber(1, 100, randomIntFn);

    if (roll <= stage.bustAtOrBelow) {
      stageSummary.push(`${stage.label} bust (${roll})`);
      return {
        entrantId,
        points,
        clears,
        lastSafeRoll,
        stageSummary
      };
    }

    points += stage.points;
    clears += 1;
    lastSafeRoll = roll;
    stageSummary.push(`${stage.label} +${stage.points} (${roll})`);
  }

  return {
    entrantId,
    points,
    clears,
    lastSafeRoll,
    stageSummary
  };
}

function compareRiskRunResults(left, right) {
  if (right.points !== left.points) {
    return right.points - left.points;
  }

  if (right.clears !== left.clears) {
    return right.clears - left.clears;
  }

  return right.lastSafeRoll - left.lastSafeRoll;
}

function rollSlotSpin(randomIntFn) {
  const reels = Array.from({ length: 3 }, () => {
    const symbol = SLOT_SYMBOLS[pickRandomIndex(SLOT_SYMBOLS.length, randomIntFn)];
    return symbol;
  });
  const labels = reels.map((symbol) => symbol.label);
  const counts = countLabels(labels);
  const sortedCounts = Array.from(counts.values()).sort((left, right) => right - left);
  const totalValue = reels.reduce((sum, symbol) => sum + symbol.value, 0);
  const valuesDescending = reels
    .map((symbol) => symbol.value)
    .sort((left, right) => right - left);
  const primaryValue = valuesDescending[0];
  const secondaryValue = valuesDescending[1];
  const tertiaryValue = valuesDescending[2];
  let label = 'No match';
  let rank = 1;

  if (sortedCounts[0] === 3) {
    const tripleLabel = labels[0];
    rank = tripleLabel === '7' ? 4 : 3;
    label = tripleLabel === '7' ? 'JACKPOT' : `Triple ${tripleLabel}`;
  } else if (sortedCounts[0] === 2) {
    const pairLabel = Array.from(counts.entries()).find(([, count]) => count === 2)?.[0] || labels[0];
    const kickerLabel = Array.from(counts.entries()).find(([, count]) => count === 1)?.[0] || labels[2];
    const pairValue = SLOT_SYMBOLS.find((symbol) => symbol.label === pairLabel)?.value || 0;
    const kickerValue =
      SLOT_SYMBOLS.find((symbol) => symbol.label === kickerLabel)?.value || 0;
    rank = 2;
    return {
      reels: labels,
      label: `Pair ${pairLabel}`,
      rank,
      tieScore: (pairValue * 100) + kickerValue
    };
  }

  return {
    reels: labels,
    label,
    rank,
    tieScore:
      (totalValue * 1_000) +
      (primaryValue * 100) +
      (secondaryValue * 10) +
      tertiaryValue
  };
}

function compareSlotSpinResults(left, right) {
  if (left.rank !== right.rank) {
    return left.rank - right.rank;
  }

  return left.tieScore - right.tieScore;
}

function buildInsufficientPlayersResult(gameType, participantIds, detail) {
  if (!participantIds.length) {
    return buildResult({
      gameType
    });
  }

  return buildResult({
    gameType,
    participantIds,
    winnerIds: participantIds.slice(0, 1),
    summaryLine: `${formatUserMention(participantIds[0])} wins by default.`,
    detailLines: [detail]
  });
}

function buildResult({
  gameType = GIVEAWAY_GAME_TYPE_STANDARD,
  participantIds = [],
  winnerIds = [],
  summaryLine = null,
  detailLines = []
} = {}) {
  const normalizedGameType = normalizeGiveawayGameType(gameType);

  return {
    gameType: normalizedGameType,
    gameLabel: getGiveawayGameTypeLabel(normalizedGameType),
    participantIds: normalizeIdList(participantIds),
    winnerIds: normalizeIdList(winnerIds),
    summaryLine: summaryLine ? String(summaryLine) : null,
    detailLines: Array.isArray(detailLines)
      ? detailLines
          .map((detailLine) => String(detailLine || '').trim())
          .filter(Boolean)
      : []
  };
}

function pickRandomEntries(entries, count, randomIntFn) {
  const pool = normalizeIdList(entries);
  const selected = [];
  const selectedCount = Math.min(pool.length, Math.max(0, Math.floor(Number(count) || 0)));

  while (selected.length < selectedCount && pool.length) {
    selected.push(pool.splice(pickRandomIndex(pool.length, randomIntFn), 1)[0]);
  }

  return selected;
}

function pickRandomIndex(length, randomIntFn) {
  if (!Number.isFinite(length) || length <= 1) {
    return 0;
  }

  return Math.max(0, Math.min(length - 1, Math.floor(randomIntFn(length))));
}

function pickRandomNumber(min, max, randomIntFn) {
  const normalizedMin = Math.floor(Number(min) || 0);
  const normalizedMax = Math.floor(Number(max) || 0);

  if (normalizedMax <= normalizedMin) {
    return normalizedMin;
  }

  return normalizedMin + pickRandomIndex((normalizedMax - normalizedMin) + 1, randomIntFn);
}

function countLabels(labels) {
  const counts = new Map();

  for (const label of labels) {
    counts.set(label, (counts.get(label) || 0) + 1);
  }

  return counts;
}

function formatCount(value) {
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 0
  }).format(Math.max(0, Math.floor(Number(value) || 0)));
}

function formatUserMention(userId) {
  return `<@${userId}>`;
}

function normalizeIdList(value) {
  return Array.from(
    new Set(
      Array.isArray(value)
        ? value
            .map((entry) => String(entry || '').trim())
            .filter(Boolean)
        : []
    )
  );
}

module.exports = {
  resolveGiveawayGame
};
