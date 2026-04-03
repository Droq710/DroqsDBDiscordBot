const { EmbedBuilder } = require('discord.js');
const {
  BOT_RUN_RESULTS_NOTE,
  addRunResultsNote,
  formatMoney,
  toDiscordTimestamp
} = require('./formatters');

const RUN_EMBED_COLOR = 0x2ecc71;
const DEFAULT_SOURCE_LABEL = 'DroqsDB Public API';

const SELL_PRICE_TARGETS = Object.freeze([
  Object.freeze({
    key: 'market',
    label: 'Item Market',
    valueKey: 'marketValue'
  }),
  Object.freeze({
    key: 'bazaar',
    label: 'Bazaar',
    valueKey: 'bazaarPrice'
  })
]);

function toNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string' && !value.trim()) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatCount(value) {
  const numeric = toNumber(value);

  if (numeric === null) {
    return 'N/A';
  }

  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 0
  }).format(numeric);
}

function formatDurationMinutes(value) {
  const numeric = toNumber(value);

  if (numeric === null || numeric < 0) {
    return 'Unavailable';
  }

  const totalMinutes = Math.max(0, Math.round(numeric));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const parts = [];

  if (hours > 0) {
    parts.push(`${hours}h`);
  }

  if (minutes > 0 || !parts.length) {
    parts.push(`${minutes}m`);
  }

  return parts.join(' ');
}

function formatGuidanceDepartAtTct(value) {
  const explicitTct = String(value || '').trim();

  if (!explicitTct) {
    return null;
  }

  return /tct/i.test(explicitTct) ? explicitTct : `${explicitTct} TCT`;
}

function formatGuidance(guidance) {
  const departInMinutes = toNumber(guidance?.departInMinutes ?? guidance?.departureMinutes);
  let timingSummary = null;

  if (departInMinutes !== null) {
    timingSummary = `Leave in ${formatDurationMinutes(Math.max(0, departInMinutes))}`;
  } else {
    const departAtTct = formatGuidanceDepartAtTct(guidance?.departAtTct);

    if (departAtTct) {
      timingSummary = `Depart at ${departAtTct}`;
    }
  }

  if (!timingSummary) {
    return null;
  }

  if (guidance?.timingTight === true || guidance?.tightWindow === true) {
    return `${timingSummary} (tight window)`;
  }

  return timingSummary;
}

function joinCompactParts(parts) {
  return parts.filter(Boolean).join(' | ');
}

function isSyntheticGuidanceRun(run) {
  return run?.isSyntheticGuidance === true;
}

function isGuidedDisplayRun(run) {
  return (
    isSyntheticGuidanceRun(run) ||
    isProjectedOnArrivalRun(run) ||
    toNumber(run?.departInMinutes) !== null
  );
}

function buildGuidanceRun(guidance) {
  const itemName = String(guidance?.itemName || '').trim();
  const country = String(guidance?.country || '').trim();
  const guidanceSummary = formatGuidance(guidance);

  if (!itemName || !country || !guidanceSummary) {
    return null;
  }

  return {
    itemName,
    country,
    departInMinutes: toNumber(guidance?.departInMinutes ?? guidance?.departureMinutes),
    departAtTct: formatGuidanceDepartAtTct(guidance?.departAtTct),
    availabilityWindowMinutes: toNumber(
      guidance?.availabilityWindowMinutes ?? guidance?.viableWindowDurationMinutes
    ),
    timingTight: guidance?.timingTight === true || guidance?.tightWindow === true,
    isSyntheticGuidance: true
  };
}

function normalizeComparableText(value) {
  return String(value || '').trim().toLowerCase();
}

function formatFooterDate(value) {
  const timestamp = Date.parse(value || '');

  if (!Number.isFinite(timestamp)) {
    return 'Unknown';
  }

  return new Date(timestamp).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
}

function buildBaseEmbed({
  title,
  description,
  url
}) {
  const embed = new EmbedBuilder().setTitle(title).setColor(RUN_EMBED_COLOR);

  if (description) {
    embed.setDescription(description);
  }

  if (url) {
    embed.setURL(url);
  }

  return embed;
}

function addFreshnessFooter(embed, generatedAt, sourceLabel = DEFAULT_SOURCE_LABEL) {
  const footerText = generatedAt
    ? `Source: ${sourceLabel} | Generated ${formatFooterDate(generatedAt)}`
    : `Source: ${sourceLabel}`;

  embed.setFooter({
    text: footerText
  });

  return embed;
}

function buildRunFieldName(run, index, {
  scopeCountry = null
} = {}) {
  const parts = [String(run?.itemName || '').trim() || 'Run'];

  if (
    run?.country &&
    normalizeComparableText(run.country) !== normalizeComparableText(scopeCountry)
  ) {
    parts.push(run.country);
  }

  return `#${index + 1} ${parts.join(' - ')}`;
}

function buildRunScopeSummary(run, {
  scopeCategory = null
} = {}) {
  const parts = [];

  if (
    run?.category &&
    normalizeComparableText(run.category) !== normalizeComparableText(scopeCategory)
  ) {
    parts.push(run.category);
  }

  return parts.join(' - ');
}

function buildRunFreshnessSummary(run) {
  return joinCompactParts([
    run.stockUpdatedAt ? `Stock ${toDiscordTimestamp(run.stockUpdatedAt, 'R')}` : null,
    run.pricingUpdatedAt ? `Pricing ${toDiscordTimestamp(run.pricingUpdatedAt, 'R')}` : null
  ]);
}

function isRunCurrentlyInStock(run) {
  if (typeof run?.isCurrentlyInStock === 'boolean') {
    return run.isCurrentlyInStock;
  }

  return toNumber(run?.stock) > 0;
}

function isProjectedOnArrivalRun(run) {
  return (
    run?.isProjectedViable === true ||
    normalizeComparableText(run?.availabilityState) === 'projected_on_arrival'
  );
}

function buildRunAvailabilityAnnotations(run) {
  const annotations = [];
  const departInMinutes = toNumber(run?.departInMinutes);

  if (isProjectedOnArrivalRun(run)) {
    if (departInMinutes !== null && departInMinutes > 0) {
      annotations.push(`Leave in ${formatDurationMinutes(departInMinutes)}`);
    } else if (!isRunCurrentlyInStock(run)) {
      annotations.push('In stock on arrival');
    } else {
      annotations.push('Projected on arrival');
    }
  }

  if (run?.timingTight === true) {
    annotations.push('Tight window');
  }

  return annotations;
}

function buildGuidedTimingParts(run) {
  const parts = [];
  const departInMinutes = toNumber(run?.departInMinutes);
  const departAtTct = formatGuidanceDepartAtTct(run?.departAtTct);
  const availabilityWindowMinutes = toNumber(run?.availabilityWindowMinutes);

  if (departInMinutes !== null) {
    parts.push(departInMinutes <= 0 ? 'Leave now' : `Leave in ${formatDurationMinutes(departInMinutes)}`);
  }

  if (departAtTct) {
    parts.push(departInMinutes === null ? `Depart at ${departAtTct}` : departAtTct);
  }

  if (availabilityWindowMinutes !== null) {
    parts.push(`Window ${formatDurationMinutes(availabilityWindowMinutes)}`);
  }

  if (run?.timingTight === true) {
    parts.push('Tight window');
  }

  return parts;
}

function buildRunStockSummary(run) {
  const annotations = buildRunAvailabilityAnnotations(run);
  const stockLabel = `Stock: ${formatCount(run.stock)}`;

  return annotations.length ? `${stockLabel} • ${annotations.join(' • ')}` : stockLabel;
}

function buildGuidedRunDetails(run, {
  scopeCategory = null
} = {}) {
  const parts = [];
  const scopeSummary = buildRunScopeSummary(run, { scopeCategory });
  const stock = toNumber(run?.stock);

  if (scopeSummary) {
    parts.push(scopeSummary);
  }

  if (stock !== null) {
    parts.push(`Stock: ${formatCount(stock)}`);
  }

  if (stock !== null && !isRunCurrentlyInStock(run)) {
    parts.push('Projected on arrival');
  }

  return joinCompactParts(parts);
}

function formatSourceFreshness(label, source, updatedAt) {
  return joinCompactParts([
    `${label}: ${source || 'Unknown'}`,
    updatedAt ? toDiscordTimestamp(updatedAt, 'R') : null
  ]);
}

function formatSellPrice(target, value) {
  if (target === 'bazaar' && toNumber(value) === null) {
    return 'Unavailable';
  }

  return formatMoney(value);
}

function getHigherSellPriceTarget(run) {
  const marketPrice = toNumber(run?.marketValue);
  const bazaarPrice = toNumber(run?.bazaarPrice);

  if (marketPrice === null || bazaarPrice === null || marketPrice === bazaarPrice) {
    return null;
  }

  return marketPrice > bazaarPrice ? 'market' : 'bazaar';
}

function buildSellPriceSummary(run) {
  const highlightedTarget = getHigherSellPriceTarget(run);

  return SELL_PRICE_TARGETS.map((target) => {
    const priceLabel = `${target.label}: ${formatSellPrice(target.key, run?.[target.valueKey])}`;
    return target.key === highlightedTarget ? `**${priceLabel}**` : priceLabel;
  }).join(' | ');
}

function buildGuidedRunProfitSummary(run) {
  return joinCompactParts([
    toNumber(run?.profitPerMinute) !== null
      ? `Profit/min: ${formatMoney(run.profitPerMinute, { signed: true })}`
      : null,
    toNumber(run?.profitPerItem) !== null
      ? `Profit/item: ${formatMoney(run.profitPerItem, { signed: true })}`
      : null
  ]);
}

function buildCompactGuidedRunDescription(description, run, {
  scopeCategory = null
} = {}) {
  const sections = [String(description || '').trim()].filter(Boolean);
  const detailLines = [];
  const targetLabel = [run?.itemName, run?.country].filter(Boolean).join(' - ');
  const timingSummary = joinCompactParts(buildGuidedTimingParts(run));
  const profitSummary = buildGuidedRunProfitSummary(run);
  const detailSummary = buildGuidedRunDetails(run, { scopeCategory });

  if (targetLabel) {
    detailLines.push(`**Next best run:** ${targetLabel}`);
  }

  if (timingSummary) {
    detailLines.push(`**Timing:** ${timingSummary}`);
  }

  if (profitSummary) {
    detailLines.push(`**Profit:** ${profitSummary}`);
  }

  if (detailSummary) {
    detailLines.push(`**Details:** ${detailSummary}`);
  }

  if (detailLines.length) {
    sections.push(detailLines.join('\n'));
  }

  return sections.join('\n\n');
}

function buildCompactGuidedRunEmbed({
  title,
  description,
  run,
  generatedAt,
  url,
  scopeCategory = null,
  sourceLabel = DEFAULT_SOURCE_LABEL,
  disclaimer = BOT_RUN_RESULTS_NOTE
}) {
  const embed = buildBaseEmbed({
    title,
    description: buildCompactGuidedRunDescription(description, run, {
      scopeCategory
    }),
    url
  });

  addRunResultsNote(embed, disclaimer);
  return addFreshnessFooter(embed, generatedAt, sourceLabel);
}

function buildRunFieldValue(run, {
  scopeCategory = null
} = {}) {
  if (isGuidedDisplayRun(run)) {
    return [
      joinCompactParts(buildGuidedTimingParts(run)),
      buildGuidedRunProfitSummary(run),
      buildGuidedRunDetails(run, { scopeCategory })
    ].filter(Boolean).join('\n');
  }

  const scopeSummary = buildRunScopeSummary(run, { scopeCategory });
  const freshnessSummary = buildRunFreshnessSummary(run);
  const lines = [
    joinCompactParts([
      `Profit/min: ${formatMoney(run.profitPerMinute, { signed: true })}`,
      `Profit/item: ${formatMoney(run.profitPerItem, { signed: true })}`
    ]),
    buildRunStockSummary(run),
    `Sell: ${buildSellPriceSummary(run)}`
  ];
  const metaLine = joinCompactParts([scopeSummary, freshnessSummary]);

  if (metaLine) {
    lines.push(metaLine);
  }

  return lines.join('\n');
}

function buildRunListEmbed({
  title,
  description,
  runs,
  generatedAt,
  url,
  scopeCountry = null,
  scopeCategory = null,
  sourceLabel = DEFAULT_SOURCE_LABEL,
  disclaimer = BOT_RUN_RESULTS_NOTE
}) {
  const normalizedRuns = Array.isArray(runs) ? runs.filter(Boolean) : [];

  if (normalizedRuns.length === 1 && isGuidedDisplayRun(normalizedRuns[0])) {
    return buildCompactGuidedRunEmbed({
      title,
      description,
      run: normalizedRuns[0],
      generatedAt,
      url,
      scopeCategory,
      sourceLabel,
      disclaimer
    });
  }

  const embed = buildBaseEmbed({
    title,
    description,
    url
  });

  for (const [index, run] of normalizedRuns.entries()) {
    embed.addFields({
      name: buildRunFieldName(run, index, { scopeCountry }),
      value: buildRunFieldValue(run, { scopeCategory }),
      inline: false
    });
  }

  addRunResultsNote(embed, disclaimer);
  return addFreshnessFooter(embed, generatedAt, sourceLabel);
}

function buildBestRunEmbed({
  run,
  generatedAt,
  url,
  sourceLabel = DEFAULT_SOURCE_LABEL,
  disclaimer = BOT_RUN_RESULTS_NOTE
}) {
  const embed = buildBaseEmbed({
    title: 'Best Run Right Now',
    description: [
      `**${[run.itemName, run.country].filter(Boolean).join(' - ')}**`,
      joinCompactParts([
        `Profit/min: ${formatMoney(run.profitPerMinute, { signed: true })}`,
        `Profit/item: ${formatMoney(run.profitPerItem, { signed: true })}`
      ]),
      joinCompactParts([
        run.category || null,
        buildRunStockSummary(run)
      ])
    ].join('\n'),
    url
  });

  embed.addFields(
    {
      name: 'Sell Prices',
      value: buildSellPriceSummary(run),
      inline: false
    },
    {
      name: 'Freshness',
      value: joinCompactParts([
        formatSourceFreshness('Stock', run.source, run.stockUpdatedAt),
        formatSourceFreshness('Pricing', run.pricingSource, run.pricingUpdatedAt)
      ]),
      inline: false
    }
  );

  addRunResultsNote(embed, disclaimer);
  return addFreshnessFooter(embed, generatedAt, sourceLabel);
}

module.exports = {
  BOT_RUN_RESULTS_NOTE,
  buildBestRunEmbed,
  buildGuidanceRun,
  buildRunListEmbed,
  formatGuidance
};
