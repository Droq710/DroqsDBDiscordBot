const { EmbedBuilder } = require('discord.js');
const { COMMAND_HELP_ENTRIES } = require('../discord/commandCatalog');
const { formatAutopostFilters } = require('./autopost');

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

const moneyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2
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

function addFreshnessFooter(embed, generatedAt) {
  const footerText = generatedAt
    ? `Source: DroqsDB Public API | Generated ${formatFooterDate(generatedAt)}`
    : 'Source: DroqsDB Public API';

  embed.setFooter({
    text: footerText
  });

  return embed;
}

function runFieldValue(run, activeSellTarget) {
  const lines = [
    `${run.country} - ${run.category}`,
    `Stock: ${formatCount(run.stock)} | Buy: ${formatMoney(run.buyPrice)}`,
    `Sell: ${buildSellPriceSummary(run, activeSellTarget)}`,
    `Profit/item: ${formatMoney(run.profitPerItem, { signed: true })} | Profit/min: ${formatMoney(run.profitPerMinute, { signed: true })}`
  ];

  if (run.stockUpdatedAt) {
    lines.push(`Stock updated ${toDiscordTimestamp(run.stockUpdatedAt, 'R')}`);
  }

  return lines.join('\n');
}

function buildRunListEmbed({
  title,
  description,
  runs,
  generatedAt,
  url,
  activeSellTarget = 'market'
}) {
  const embed = buildBaseEmbed({
    title,
    description,
    color: COLORS.success,
    url
  });

  for (const [index, run] of runs.entries()) {
    embed.addFields({
      name: `#${index + 1} ${run.itemName}`,
      value: runFieldValue(run, activeSellTarget),
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
    title: `Best Run Right Now: ${run.itemName}`,
    description: `${run.country} - ${run.category}`,
    color: COLORS.success,
    url
  });

  embed.addFields(
    {
      name: 'Stock',
      value: formatCount(run.stock),
      inline: true
    },
    {
      name: 'Buy Price',
      value: formatMoney(run.buyPrice),
      inline: true
    },
    buildSellPriceField('market', run, activeSellTarget),
    buildSellPriceField('bazaar', run, activeSellTarget),
    buildSellPriceField('torn', run, activeSellTarget),
    {
      name: 'Profit / Item',
      value: formatMoney(run.profitPerItem, { signed: true }),
      inline: true
    },
    {
      name: 'Profit / Minute',
      value: formatMoney(run.profitPerMinute, { signed: true }),
      inline: true
    },
    {
      name: 'Stock Source',
      value: `${run.source || 'Unknown'} - ${toDiscordTimestamp(run.stockUpdatedAt, 'R')}`,
      inline: true
    },
    {
      name: 'Pricing Source',
      value: `${run.pricingSource || 'Unknown'} - ${toDiscordTimestamp(run.pricingUpdatedAt, 'R')}`,
      inline: true
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

function buildHelpEmbed({ webBaseUrl }) {
  const embed = buildBaseEmbed({
    title: 'DroqsDB Bot Help',
    description:
      'This bot reads live data from the DroqsDB Public API and shows travel profitability, stock, pricing, and restock information inside Discord.',
    color: COLORS.info,
    url: webBaseUrl
  });

  embed.addFields(
    ...COMMAND_HELP_ENTRIES.map((entry) => ({
      name: entry.name,
      value: entry.value,
      inline: false
    })),
    {
      name: 'Usage Notes',
      value:
        'Item names support autocomplete. Commands are rate limited per user and per server to keep the bot responsive. If DroqsDB is briefly unavailable, the bot may use recent cached data or ask you to try again shortly.',
      inline: false
    }
  );

  return addFreshnessFooter(embed);
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
      description: 'Autopost has not been configured for this server yet.',
      color: COLORS.info,
      url
    });
  }

  const embed = buildBaseEmbed({
    title: 'Autopost Status',
    description: config.autopostEnabled
      ? 'Hourly autoposting is enabled for this server.'
      : 'Hourly autoposting is currently disabled for this server.',
    color: config.autopostEnabled ? COLORS.success : COLORS.warning,
    url
  });

  embed.addFields(
    {
      name: 'Status',
      value: config.autopostEnabled ? 'Enabled' : 'Disabled',
      inline: true
    },
    {
      name: 'Channel',
      value: config.channelId ? `<#${config.channelId}>` : 'Not configured',
      inline: true
    },
    {
      name: 'Count',
      value: String(config.count),
      inline: true
    },
    {
      name: 'Filters',
      value: formatAutopostFilters(config),
      inline: false
    },
    {
      name: 'Updated',
      value: config.updatedAt ? toDiscordTimestamp(config.updatedAt, 'F') : 'Unknown',
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

module.exports = {
  buildAutopostStatusEmbed,
  buildBestRunEmbed,
  buildErrorEmbed,
  buildHelpEmbed,
  buildInfoEmbed,
  buildLookupErrorEmbed,
  buildPriceEmbed,
  buildRateLimitEmbed,
  buildRestockEmbed,
  buildRunListEmbed,
  buildStockEmbed,
  formatMoney,
  toDiscordTimestamp
};
