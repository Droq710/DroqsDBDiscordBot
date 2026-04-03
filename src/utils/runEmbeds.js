const { EmbedBuilder } = require('discord.js');
const { formatMoney, toDiscordTimestamp } = require('./formatters');

const RUN_EMBED_COLOR = 0x2ecc71;
const DEFAULT_SOURCE_LABEL = 'DroqsDB Public API';
const BOT_RUN_RESULTS_NOTE =
  'Bot results use 19 carry capacity and private flight. For your own settings, use the site.';

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

function buildDescriptionWithDisclaimer(description, disclaimer = BOT_RUN_RESULTS_NOTE) {
  const parts = [String(description || '').trim()].filter(Boolean);

  if (disclaimer) {
    parts.push(`*${disclaimer}*`);
  }

  return parts.join('\n\n');
}

function buildRunFieldName(run, index, {
  scopeCountry = null
} = {}) {
  if (isSyntheticGuidanceRun(run)) {
    return `#${index + 1} (Next) ${[run.itemName, run.country].filter(Boolean).join(' - ')}`;
  }

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

function buildRunStockSummary(run) {
  const annotations = buildRunAvailabilityAnnotations(run);
  const stockLabel = `Stock: ${formatCount(run.stock)}`;

  return annotations.length ? `${stockLabel} • ${annotations.join(' • ')}` : stockLabel;
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

function buildRunFieldValue(run, {
  scopeCategory = null
} = {}) {
  if (isSyntheticGuidanceRun(run)) {
    const lines = [formatGuidance(run)];
    const availabilityWindowMinutes = toNumber(run?.availabilityWindowMinutes);

    if (availabilityWindowMinutes !== null) {
      lines.push(`Window: ${formatDurationMinutes(availabilityWindowMinutes)}`);
    }

    return lines.filter(Boolean).join('\n');
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
  const embed = buildBaseEmbed({
    title,
    description: buildDescriptionWithDisclaimer(description, disclaimer),
    url
  });

  for (const [index, run] of runs.entries()) {
    embed.addFields({
      name: buildRunFieldName(run, index, { scopeCountry }),
      value: buildRunFieldValue(run, { scopeCategory }),
      inline: false
    });
  }

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
    description: buildDescriptionWithDisclaimer(
      [
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
      disclaimer
    ),
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

  return addFreshnessFooter(embed, generatedAt, sourceLabel);
}

module.exports = {
  BOT_RUN_RESULTS_NOTE,
  buildBestRunEmbed,
  buildGuidanceRun,
  buildRunListEmbed,
  formatGuidance
};
