const { EmbedBuilder } = require('discord.js');
const { COMMAND_HELP_ENTRIES } = require('../discord/commandCatalog');
const {
  formatAutopostFilters,
  formatAutopostMode,
  formatAutopostModeSummary
} = require('./autopost');

const COLORS = Object.freeze({
  info: 0x5865f2,
  success: 0x2ecc71,
  warning: 0xf1c40f,
  error: 0xe74c3c
});

const SELL_TARGETS = Object.freeze({
  market: Object.freeze({
    fieldName: 'Market Price',
    listLabel: 'Market',
    valueKey: 'marketValue'
  }),
  bazaar: Object.freeze({
    fieldName: 'Bazaar Price',
    listLabel: 'Bazaar',
    valueKey: 'bazaarPrice'
  }),
  torn: Object.freeze({
    fieldName: 'Torn City Shops',
    listLabel: 'Torn',
    valueKey: 'tornCityShops'
  })
});

const HELP_GROUPS = Object.freeze([
  Object.freeze({
    title: 'General',
    commandNames: ['/help']
  }),
  Object.freeze({
    title: 'Runs',
    commandNames: [
      '/run best',
      '/run top',
      '/run selltarget',
      '/run country',
      '/run item',
      '/run category'
    ]
  }),
  Object.freeze({
    title: 'Pricing & Stock',
    commandNames: ['/price', '/stock', '/restock']
  }),
  Object.freeze({
    title: 'Autopost',
    commandNames: ['/autopost enable', '/autopost disable', '/autopost status']
  }),
  Object.freeze({
    title: 'Giveaways',
    commandNames: ['/giveaway status', '/giveaway start', '/giveaway end', '/giveaway reroll']
  })
]);

const moneyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2
});

const tctTimeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
});

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

function formatMoney(value, { signed = false } = {}) {
  const numeric = toNumber(value);

  if (numeric === null) {
    return 'N/A';
  }

  const absolute = moneyFormatter.format(Math.abs(numeric));

  if (!signed) {
    return moneyFormatter.format(numeric);
  }

  if (numeric > 0) {
    return `+${absolute}`;
  }

  if (numeric < 0) {
    return `-${absolute}`;
  }

  return absolute;
}

function normalizeSellTarget(value) {
  const normalized = String(value || '').trim().toLowerCase();

  if (!normalized) {
    return null;
  }

  if (['market', 'marketvalue', 'market price'].includes(normalized)) {
    return 'market';
  }

  if (['bazaar', 'bazaarprice', 'bazaar price'].includes(normalized)) {
    return 'bazaar';
  }

  if (['torn', 'torncityshops', 'torn city shops', 'shops', 'shop'].includes(normalized)) {
    return 'torn';
  }

  return null;
}

function getActiveSellTarget(value) {
  return normalizeSellTarget(value) || 'market';
}

function getSellTargetListLabel(target) {
  return SELL_TARGETS[getActiveSellTarget(target)]?.listLabel || SELL_TARGETS.market.listLabel;
}

function normalizeComparableText(value) {
  return String(value || '').trim().toLowerCase();
}

function formatSellTargetPrice(target, value) {
  if (target === 'bazaar' && toNumber(value) === null) {
    return 'Unavailable';
  }

  return formatMoney(value);
}

function buildSellPriceSummary(run, activeSellTarget) {
  const selectedTarget = getActiveSellTarget(activeSellTarget);

  return Object.entries(SELL_TARGETS)
    .map(([target, metadata]) => {
      const price = formatSellTargetPrice(target, run[metadata.valueKey]);
      const label = `${metadata.listLabel}: ${price}`;
      return target === selectedTarget ? `**${label}**` : label;
    })
    .join(' | ');
}

function buildSellPriceField(target, run, activeSellTarget) {
  const metadata = SELL_TARGETS[target];
  const selectedTarget = getActiveSellTarget(activeSellTarget);
  const price = formatSellTargetPrice(target, run[metadata.valueKey]);
  const isActive = target === selectedTarget;

  return {
    name: isActive ? `${metadata.fieldName} (Active)` : metadata.fieldName,
    value: isActive ? `**${price}**` : price,
    inline: true
  };
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

function formatDurationMinutes(value, { approximate = false } = {}) {
  const numeric = toNumber(value);

  if (numeric === null || numeric < 0) {
    return approximate ? '~Unavailable' : 'Unavailable';
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

  return `${approximate ? '~' : ''}${parts.join(' ')}`;
}

function toDiscordTimestamp(value, style = 'R') {
  const timestamp = Date.parse(value || '');

  if (!Number.isFinite(timestamp)) {
    return 'Unknown';
  }

  return `<t:${Math.floor(timestamp / 1000)}:${style}>`;
}

function formatFooterDate(value) {
  const timestamp = Date.parse(value || '');

  if (!Number.isFinite(timestamp)) {
    return 'Unknown';
  }

  return new Date(timestamp).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
}

function formatTctClockTime(value) {
  const timestamp = Date.parse(value || '');

  if (!Number.isFinite(timestamp)) {
    return 'Unknown';
  }

  return tctTimeFormatter.format(new Date(timestamp));
}

function buildBaseEmbed({
  title,
  description,
  color = COLORS.info,
  url
}) {
  const embed = new EmbedBuilder().setTitle(title).setColor(color);

  if (description) {
    embed.setDescription(description);
  }

  if (url) {
    embed.setURL(url);
  }

  return embed;
}

function addFreshnessFooter(embed, generatedAt, sourceLabel = 'DroqsDB Public API') {
  const footerText = generatedAt
    ? `Source: ${sourceLabel} | Generated ${formatFooterDate(generatedAt)}`
    : `Source: ${sourceLabel}`;

  embed.setFooter({
    text: footerText
  });

  return embed;
}

function joinCompactParts(parts) {
  return parts.filter(Boolean).join(' | ');
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
    run.category &&
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

function buildRunStockSummary(run, { includeColon = true } = {}) {
  const stockLabel = includeColon
    ? `Stock: ${formatCount(run.stock)}`
    : `Stock ${formatCount(run.stock)}`;
  const annotations = buildRunAvailabilityAnnotations(run);

  return annotations.length ? `${stockLabel} • ${annotations.join(' • ')}` : stockLabel;
}

function formatSourceFreshness(label, source, updatedAt) {
  return joinCompactParts([
    `${label}: ${source || 'Unknown'}`,
    updatedAt ? toDiscordTimestamp(updatedAt, 'R') : null
  ]);
}

function runFieldValue(run, activeSellTarget, {
  scopeCategory = null
} = {}) {
  const scopeSummary = buildRunScopeSummary(run, { scopeCategory });
  const freshnessSummary = buildRunFreshnessSummary(run);
  const lines = [
    joinCompactParts([
      `Profit/min: ${formatMoney(run.profitPerMinute, { signed: true })}`,
      `Profit/item: ${formatMoney(run.profitPerItem, { signed: true })}`
    ]),
    joinCompactParts([
      buildRunStockSummary(run),
      `Buy: ${formatMoney(run.buyPrice)}`
    ]),
    `Sell: ${buildSellPriceSummary(run, activeSellTarget)}`
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
  activeSellTarget = 'market',
  scopeCountry = null,
  scopeCategory = null
}) {
  const embed = buildBaseEmbed({
    title,
    description,
    color: COLORS.success,
    url
  });

  for (const [index, run] of runs.entries()) {
    embed.addFields({
      name: buildRunFieldName(run, index, { scopeCountry }),
      value: runFieldValue(run, activeSellTarget, {
        scopeCategory
      }),
      inline: false
    });
  }

  return addFreshnessFooter(embed, generatedAt);
}

function buildBestRunEmbed({
  run,
  generatedAt,
  url,
  activeSellTarget = 'market'
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
        `Stock: ${formatCount(run.stock)}`,
        `Buy: ${formatMoney(run.buyPrice)}`
      ])
    ].join('\n'),
    color: COLORS.success,
    url
  });

  embed.addFields(
    {
      name: `Sell Prices (${getSellTargetListLabel(activeSellTarget)} active)`,
      value: buildSellPriceSummary(run, activeSellTarget),
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

  return addFreshnessFooter(embed, generatedAt);
}

function buildPriceEmbed({
  item,
  generatedAt,
  url
}) {
  const embed = buildBaseEmbed({
    title: `Price Snapshot: ${item.itemName}`,
    description: `${item.category} - Best country: ${item.bestCountry || 'N/A'}`,
    color: COLORS.info,
    url
  });

  embed.addFields(
    {
      name: 'Market Price',
      value: formatMoney(item.bestMarketValue),
      inline: true
    },
    {
      name: 'Bazaar Price',
      value: formatMoney(item.bestBazaarPrice),
      inline: true
    },
    {
      name: 'Torn City Shops',
      value: formatMoney(item.bestTornCityShops),
      inline: true
    },
    {
      name: 'Best Buy Price',
      value: formatMoney(item.bestBuyPrice),
      inline: true
    },
    {
      name: 'Best Profit / Item',
      value: formatMoney(item.bestProfitPerItem, { signed: true }),
      inline: true
    },
    {
      name: 'Best Profit / Minute',
      value: formatMoney(item.bestProfitPerMinute, { signed: true }),
      inline: true
    },
    {
      name: 'Countries Tracked',
      value: formatCount(item.countryCount),
      inline: true
    },
    {
      name: 'Profitable Countries',
      value: formatCount(item.profitableCountryCount),
      inline: true
    },
    {
      name: 'Restock Estimate Available',
      value: item.hasRestockEstimate ? 'Yes' : 'No',
      inline: true
    }
  );

  return addFreshnessFooter(embed, generatedAt);
}

function buildStockEmbed({
  item,
  country,
  row,
  generatedAt,
  url
}) {
  const inStock = Number(row.stock) > 0;
  const embed = buildBaseEmbed({
    title: `Stock Check: ${item.itemName}`,
    description: `${country} - ${row.category}`,
    color: inStock ? COLORS.success : COLORS.warning,
    url
  });

  embed.addFields(
    {
      name: 'Status',
      value: inStock ? 'In stock' : 'Out of stock',
      inline: true
    },
    {
      name: 'Stock',
      value: formatCount(row.stock),
      inline: true
    },
    {
      name: 'Buy Price',
      value: formatMoney(row.buyPrice),
      inline: true
    },
    {
      name: 'Profit / Item',
      value: formatMoney(row.profitPerItem, { signed: true }),
      inline: true
    },
    {
      name: 'Profit / Minute',
      value: formatMoney(row.profitPerMinute, { signed: true }),
      inline: true
    },
    {
      name: 'Stock Freshness',
      value: `${row.source || 'Unknown'} - ${toDiscordTimestamp(row.stockUpdatedAt, 'R')}`,
      inline: true
    }
  );

  return addFreshnessFooter(embed, generatedAt);
}

function buildRestockEmbed({
  item,
  country,
  row,
  generatedAt,
  url
}) {
  const inStock = Number(row.stock) > 0;
  const estimate = row.estimatedRestockDisplay && row.estimatedRestockDisplay !== '~0m'
    ? row.estimatedRestockDisplay
    : 'Unavailable';
  const embed = buildBaseEmbed({
    title: `Restock Check: ${item.itemName}`,
    description: `${country} - ${row.category}`,
    color: inStock ? COLORS.success : COLORS.warning,
    url
  });

  embed.addFields(
    {
      name: 'Status',
      value: inStock ? 'Currently in stock' : 'Currently out of stock',
      inline: true
    },
    {
      name: 'Current Stock',
      value: formatCount(row.stock),
      inline: true
    },
    {
      name: 'Estimated Restock',
      value: inStock ? 'Not needed right now' : estimate,
      inline: true
    },
    {
      name: 'Buy Price',
      value: formatMoney(row.buyPrice),
      inline: true
    },
    {
      name: 'Profit / Item',
      value: formatMoney(row.profitPerItem, { signed: true }),
      inline: true
    },
    {
      name: 'Profit / Minute',
      value: formatMoney(row.profitPerMinute, { signed: true }),
      inline: true
    }
  );

  if (!inStock && Number.isFinite(Number(row.estimatedRestockMinutes))) {
    embed.addFields({
      name: 'Restock ETA',
      value: `${formatCount(row.estimatedRestockMinutes)} minute(s)`,
      inline: true
    });
  }

  embed.addFields({
    name: 'Stock Freshness',
    value: `${row.source || 'Unknown'} - ${toDiscordTimestamp(row.stockUpdatedAt, 'R')}`,
    inline: true
  });

  return addFreshnessFooter(embed, generatedAt);
}

function buildRunEmptyStateGuidanceEmbed({
  title,
  fallbackDescription,
  guidance = null,
  generatedAt = null,
  sourceLabel = 'DroqsDB Public API',
  url
}) {
  const normalizedGuidance = normalizeEmptyStateGuidance(guidance);

  if (!normalizedGuidance?.kind) {
    return addFreshnessFooter(
      buildBaseEmbed({
        title,
        description: fallbackDescription,
        color: COLORS.info,
        url
      }),
      generatedAt,
      sourceLabel
    );
  }

  if (normalizedGuidance.kind === 'next_run') {
    const lines = ['No profitable runs are live right now.'];
    const targetLabel = [normalizedGuidance.itemName, normalizedGuidance.country]
      .filter(Boolean)
      .join(' - ');
    const timingDetails = [];

    if (targetLabel) {
      lines.push(`Next best run: **${targetLabel}**`);
    }

    if (normalizedGuidance.departureMinutes !== null) {
      timingDetails.push(
        `Leave: **${
          normalizedGuidance.departureMinutes <= 0
            ? 'now'
            : `in ${formatDurationMinutes(normalizedGuidance.departureMinutes)}`
        }**`
      );
    }

    const departAtTct = formatGuidanceDepartAtTct(normalizedGuidance);

    if (departAtTct) {
      timingDetails.push(`TCT: ${departAtTct}`);
    }

    if (normalizedGuidance.availabilityWindowMinutes !== null) {
      timingDetails.push(
        `Window: ${formatDurationMinutes(normalizedGuidance.availabilityWindowMinutes, {
          approximate: true
        })}`
      );
    }

    if (timingDetails.length) {
      lines.push(timingDetails.join(' | '));
    }

    if (normalizedGuidance.tightWindow) {
      lines.push('Tight window. Be ready to leave fast.');
    } else if (!targetLabel && !timingDetails.length && normalizedGuidance.messageShort) {
      lines.push(normalizedGuidance.messageShort);
    }

    return addFreshnessFooter(
      buildBaseEmbed({
        title,
        description: lines.join('\n'),
        color: COLORS.info,
        url
      }),
      generatedAt,
      sourceLabel
    );
  }

  if (normalizedGuidance.kind === 'timing_unreliable') {
    const message =
      normalizedGuidance.messageDetailed ||
      normalizedGuidance.messageShort ||
      normalizedGuidance.message ||
      'Upcoming timing is too unstable to call a reliable departure window.';

    return addFreshnessFooter(
      buildBaseEmbed({
        title,
        description: [
          'No profitable runs are live right now.',
          message
        ].join('\n'),
        color: COLORS.warning,
        url
      }),
      generatedAt,
      sourceLabel
    );
  }

  if (normalizedGuidance.kind === 'no_viable_runs') {
    return addFreshnessFooter(
      buildBaseEmbed({
        title,
        description: fallbackDescription,
        color: COLORS.info,
        url
      }),
      generatedAt,
      sourceLabel
    );
  }

  return addFreshnessFooter(
    buildBaseEmbed({
      title,
      description: fallbackDescription,
      color: COLORS.info,
      url
    }),
    generatedAt,
    sourceLabel
  );
}

function normalizeEmptyStateGuidance(guidance) {
  if (!guidance || typeof guidance !== 'object') {
    return null;
  }

  const kind = normalizeComparableText(guidance.kind || guidance.type);

  if (!kind) {
    return null;
  }

  return {
    kind,
    type: normalizeComparableText(guidance.type || kind) || kind,
    itemName: String(guidance.itemName || '').trim() || null,
    country: String(guidance.country || '').trim() || null,
    messageShort:
      String(guidance.messageShort || guidance.message || '').trim() || null,
    messageDetailed:
      String(guidance.messageDetailed || guidance.message || '').trim() || null,
    message:
      String(guidance.messageDetailed || guidance.messageShort || guidance.message || '').trim() ||
      null,
    departureMinutes: toNumber(guidance.departureMinutes ?? guidance.departInMinutes),
    departInMinutes: toNumber(guidance.departInMinutes ?? guidance.departureMinutes),
    departureAt: guidance.departureAt || null,
    departAtTct: String(guidance.departAtTct || '').trim() || null,
    viableWindowDurationMinutes: toNumber(
      guidance.viableWindowDurationMinutes ?? guidance.availabilityWindowMinutes
    ),
    availabilityWindowMinutes: toNumber(
      guidance.availabilityWindowMinutes ?? guidance.viableWindowDurationMinutes
    ),
    tightWindow: guidance.tightWindow === true || guidance.timingTight === true,
    timingTight: guidance.timingTight === true || guidance.tightWindow === true
  };
}

function formatCompactAutopostRunLine(run) {
  return truncateText(
    joinCompactParts([
      `**${run.itemName}** - ${run.country}`,
      `${formatMoney(run.profitPerMinute, { signed: true })}/min`,
      buildRunStockSummary(run, { includeColon: false })
    ]),
    180
  );
}

function formatGuidanceDepartAtTct(guidance) {
  const explicitTct = String(guidance?.departAtTct || '').trim();

  if (explicitTct) {
    return /tct/i.test(explicitTct) ? explicitTct : `${explicitTct} TCT`;
  }

  if (guidance?.departureAt) {
    return `${formatTctClockTime(guidance.departureAt)} TCT`;
  }

  return null;
}

function buildAutopostSectionsEmbed({
  title,
  description,
  sections,
  generatedAt,
  url
}) {
  const embed = buildBaseEmbed({
    title,
    description,
    color: COLORS.success,
    url
  });

  for (const section of sections) {
    embed.addFields({
      name: section.title,
      value: buildAutopostSectionValue(section),
      inline: false
    });
  }

  return addFreshnessFooter(embed, generatedAt);
}

function buildHelpEmbed({ webBaseUrl }) {
  const embed = buildBaseEmbed({
    title: 'DroqsDB Bot Help',
    description:
      'Live DroqsDB travel, pricing, stock, autopost, and giveaway tools in one place.',
    color: COLORS.info,
    url: webBaseUrl
  });

  embed.addFields(
    ...HELP_GROUPS.map((group) => ({
      name: group.title,
      value: group.commandNames
        .map((commandName) =>
          formatHelpEntryLine(COMMAND_HELP_ENTRIES.find((entry) => entry.name === commandName))
        )
        .filter(Boolean)
        .join('\n'),
      inline: false
    })),
    {
      name: 'Notes',
      value:
        [
          'Item names support autocomplete.',
          'Autopost and giveaway management require `Manage Server`.',
          'If DroqsDB is briefly unavailable, the bot may use recent cached data or ask you to try again shortly.'
        ].join('\n'),
      inline: false
    }
  );

  return addFreshnessFooter(embed, null, 'DroqBot');
}

function buildInfoEmbed(title, description, { url } = {}) {
  return buildBaseEmbed({
    title,
    description,
    color: COLORS.info,
    url
  });
}

function buildErrorEmbed(title, description) {
  return buildBaseEmbed({
    title,
    description,
    color: COLORS.error
  });
}

function buildLookupErrorEmbed(error) {
  const suggestions = Array.isArray(error.suggestions) && error.suggestions.length
    ? `\n\nDid you mean:\n${error.suggestions.map((item) => `- ${item}`).join('\n')}`
    : '';

  return buildErrorEmbed('Lookup Failed', `${error.message}${suggestions}`);
}

function buildRateLimitEmbed({ retryAfterMs, scope }) {
  const retryAfterSeconds = Math.max(1, Math.ceil(Number(retryAfterMs || 0) / 1000));
  const subject = scope === 'guild' ? 'This server has' : 'You have';

  return buildInfoEmbed(
    'Rate Limit Reached',
    `${subject} sent too many slash commands too quickly. Please wait about ${retryAfterSeconds} second(s) and try again.`
  );
}

function buildAutopostStatusEmbed({
  config,
  url
}) {
  if (!config) {
    return buildBaseEmbed({
      title: 'Autopost Status',
      description: 'Autopost is not configured for this server yet.\nUse `/autopost enable` to start hourly posts.',
      color: COLORS.info,
      url
    });
  }

  const embed = buildBaseEmbed({
    title: 'Autopost Status',
    description: [
      config.autopostEnabled ? '**Enabled**' : '**Disabled**',
      `${config.autopostEnabled ? 'Channel' : 'Configured channel'}: ${
        config.channelId ? `<#${config.channelId}>` : 'Not configured'
      }`,
      `Mode: ${formatAutopostMode(config.mode)}`
    ].join('\n'),
    color: config.autopostEnabled ? COLORS.success : COLORS.warning,
    url
  });

  embed.addFields(
    {
      name: 'Mode Summary',
      value: formatAutopostModeSummary(config),
      inline: false
    },
    {
      name: 'Filters',
      value: formatAutopostFilters(config),
      inline: false
    },
    {
      name: 'Updated',
      value: config.updatedAt
        ? `${toDiscordTimestamp(config.updatedAt, 'F')} (${toDiscordTimestamp(config.updatedAt, 'R')})`
        : 'Unknown',
      inline: true
    },
    {
      name: 'Updated By',
      value: config.updatedBy ? `<@${config.updatedBy}>` : 'Unknown',
      inline: true
    }
  );

  return embed;
}

function formatHelpEntryLine(entry) {
  if (!entry) {
    return null;
  }

  const summary = String(entry.value || '')
    .split('\n')
    .slice(1)
    .join(' ')
    .trim();

  return summary ? `\`${entry.name}\` - ${summary}` : `\`${entry.name}\``;
}

function buildAutopostSectionValue(section) {
  const lines = section.runs.length
    ? section.runs.map((run, index) => `${index + 1}. ${formatCompactAutopostRunLine(run)}`)
    : ['No qualifying runs right now.'];

  return truncateLines(lines, 1024);
}

function truncateLines(lines, maxLength) {
  const normalizedLines = Array.isArray(lines) ? lines.filter(Boolean) : [];
  const keptLines = [];
  let usedLength = 0;

  for (const line of normalizedLines) {
    const additionLength = line.length + (keptLines.length ? 1 : 0);

    if (usedLength + additionLength > maxLength) {
      break;
    }

    keptLines.push(line);
    usedLength += additionLength;
  }

  const omittedCount = normalizedLines.length - keptLines.length;

  if (!omittedCount) {
    return keptLines.join('\n');
  }

  const overflowLabel = `... +${omittedCount} more`;

  while (
    keptLines.length &&
    keptLines.join('\n').length + 1 + overflowLabel.length > maxLength
  ) {
    keptLines.pop();
  }

  if (!keptLines.length) {
    return truncateText(overflowLabel, maxLength);
  }

  keptLines.push(overflowLabel);
  return keptLines.join('\n');
}

function truncateText(value, maxLength) {
  const normalizedValue = String(value || '');

  if (normalizedValue.length <= maxLength) {
    return normalizedValue;
  }

  return `${normalizedValue.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

module.exports = {
  buildAutopostSectionsEmbed,
  buildAutopostStatusEmbed,
  buildBestRunEmbed,
  buildErrorEmbed,
  buildHelpEmbed,
  buildInfoEmbed,
  buildLookupErrorEmbed,
  buildPriceEmbed,
  buildRateLimitEmbed,
  buildRestockEmbed,
  buildRunEmptyStateGuidanceEmbed,
  buildRunListEmbed,
  buildStockEmbed,
  formatMoney,
  toDiscordTimestamp
};
