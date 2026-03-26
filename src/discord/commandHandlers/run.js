const {
  buildBestRunEmbed,
  buildInfoEmbed,
  buildRunListEmbed
} = require('../../utils/formatters');
const { categoryLabel } = require('../../constants/droqsdb');

const SELL_TARGET_CONFIG = Object.freeze({
  market: Object.freeze({
    titleLabel: 'Market',
    descriptionLabel: 'market',
    hasSellPrice: (run) => Number(run?.profitPerMinute) > 0
  }),
  bazaar: Object.freeze({
    titleLabel: 'Bazaar',
    descriptionLabel: 'bazaar',
    hasSellPrice: (run) => hasPositiveNumber(run?.bazaarPrice)
  }),
  torn: Object.freeze({
    titleLabel: 'Torn',
    descriptionLabel: 'Torn City Shops',
    hasSellPrice: (run) => hasPositiveNumber(run?.tornCityShops)
  })
});

function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function hasPositiveNumber(value) {
  const numeric = toNumber(value);
  return numeric !== null && numeric > 0;
}

function sortByProfitPerMinuteDesc(left, right) {
  return Number(right?.profitPerMinute || 0) - Number(left?.profitPerMinute || 0);
}

function getSellTargetConfig(target) {
  const config = SELL_TARGET_CONFIG[target];

  if (!config) {
    throw new Error(`Unsupported run sell target "${target}".`);
  }

  return config;
}

async function execute(interaction, context) {
  const subcommand = interaction.options.getSubcommand();
  await interaction.deferReply();

  if (subcommand === 'best') {
    const payload = await context.droqsdbClient.getTopRuns();
    const bestRun = payload.items[0];

    if (!bestRun) {
      await interaction.editReply({
        embeds: [
          buildInfoEmbed(
            'No Best Run Available',
            'DroqsDB does not currently report any profitable in-stock runs.',
            { url: context.config.droqsdbWebBaseUrl }
          )
        ]
      });
      return;
    }

    await interaction.editReply({
      embeds: [
        buildBestRunEmbed({
          run: bestRun,
          generatedAt: payload.generatedAt,
          url: context.config.droqsdbWebBaseUrl,
          activeSellTarget: 'market'
        })
      ]
    });
    return;
  }

  if (subcommand === 'top') {
    const count = interaction.options.getInteger('count', true);
    const payload = await context.droqsdbClient.getTopRuns();
    const runs = payload.items.slice(0, count);

    if (!runs.length) {
      await interaction.editReply({
        embeds: [
          buildInfoEmbed(
            'No Current Runs Available',
            'DroqsDB does not currently report any profitable in-stock runs.',
            { url: context.config.droqsdbWebBaseUrl }
          )
        ]
      });
      return;
    }

    await interaction.editReply({
      embeds: [
        buildRunListEmbed({
          title: `Top ${runs.length} Runs`,
          description: 'Current profitable in-stock runs from the DroqsDB Public API.',
          runs,
          generatedAt: payload.generatedAt,
          url: context.config.droqsdbWebBaseUrl,
          activeSellTarget: 'market'
        })
      ]
    });
    return;
  }

  if (subcommand === 'selltarget') {
    const target = interaction.options.getString('target', true);
    const count = interaction.options.getInteger('count', true);
    const payload = await context.droqsdbClient.getTopRuns();
    const sellTarget = getSellTargetConfig(target);
    const runs = payload.items
      .filter((run) => sellTarget.hasSellPrice(run))
      .sort(sortByProfitPerMinuteDesc)
      .slice(0, count);

    if (!runs.length) {
      await interaction.editReply({
        embeds: [
          buildInfoEmbed(
            `No Current ${sellTarget.titleLabel} Runs Available`,
            `DroqsDB does not currently report any profitable in-stock runs with ${sellTarget.descriptionLabel} pricing available.`,
            { url: context.config.droqsdbWebBaseUrl }
          )
        ]
      });
      return;
    }

    await interaction.editReply({
      embeds: [
        buildRunListEmbed({
          title: `Top ${runs.length} Runs (${sellTarget.titleLabel})`,
          description: `Current profitable in-stock runs from the DroqsDB Public API with ${sellTarget.descriptionLabel} pricing available.`,
          runs,
          generatedAt: payload.generatedAt,
          url: context.config.droqsdbWebBaseUrl,
          activeSellTarget: target
        })
      ]
    });
    return;
  }

  if (subcommand === 'country') {
    const country = interaction.options.getString('country', true);
    const count = interaction.options.getInteger('count', true);
    const payload = await context.droqsdbClient.getCurrentRunsByCountry(country, count);

    if (!payload.runs.length) {
      await interaction.editReply({
        embeds: [
          buildInfoEmbed(
            `No Current Runs for ${payload.country}`,
            'There are no currently profitable in-stock runs for that country right now.',
            { url: context.config.droqsdbWebBaseUrl }
          )
        ]
      });
      return;
    }

    await interaction.editReply({
      embeds: [
        buildRunListEmbed({
          title: `Top ${payload.runs.length} Runs for ${payload.country}`,
          description: 'Sorted by DroqsDB API profit per minute.',
          runs: payload.runs,
          generatedAt: payload.generatedAt,
          url: context.config.droqsdbWebBaseUrl,
          activeSellTarget: 'market'
        })
      ]
    });
    return;
  }

  if (subcommand === 'item') {
    const itemName = interaction.options.getString('item', true);
    const payload = await context.droqsdbClient.getCurrentRunsByItem(itemName, 3);

    if (!payload.currentRuns.length) {
      const fallback = payload.restockableRuns[0];
      const description = fallback
        ? `No currently profitable in-stock runs are available for ${payload.item.itemName}. The soonest tracked restock is ${fallback.country} at ${fallback.estimatedRestockDisplay}.`
        : `No currently profitable in-stock runs are available for ${payload.item.itemName}.`;

      await interaction.editReply({
        embeds: [
          buildInfoEmbed(`No Current Runs for ${payload.item.itemName}`, description, {
            url: context.config.droqsdbWebBaseUrl
          })
        ]
      });
      return;
    }

    await interaction.editReply({
      embeds: [
        buildRunListEmbed({
          title: `Best Current Runs for ${payload.item.itemName}`,
          description: `${payload.item.category || 'Category unavailable'} - Showing the best currently profitable in-stock countries.`,
          runs: payload.currentRuns,
          generatedAt: payload.generatedAt,
          url: context.config.droqsdbWebBaseUrl,
          activeSellTarget: 'market'
        })
      ]
    });
    return;
  }

  if (subcommand === 'category') {
    const category = interaction.options.getString('category', true);
    const count = interaction.options.getInteger('count', true);
    const payload = await context.droqsdbClient.getCurrentRunsByCategory(category, count);

    if (!payload.runs.length) {
      await interaction.editReply({
        embeds: [
          buildInfoEmbed(
            `No Current ${categoryLabel(payload.category)} Runs`,
            'There are no currently profitable in-stock runs in that category right now.',
            { url: context.config.droqsdbWebBaseUrl }
          )
        ]
      });
      return;
    }

    await interaction.editReply({
      embeds: [
        buildRunListEmbed({
          title: `Top ${payload.runs.length} ${categoryLabel(payload.category)} Runs`,
          description: 'Filtered using the current DroqsDB site category grouping and sorted by API profit per minute.',
          runs: payload.runs,
          generatedAt: payload.generatedAt,
          url: context.config.droqsdbWebBaseUrl,
          activeSellTarget: 'market'
        })
      ]
    });
    return;
  }

  throw new Error(`Unsupported run subcommand "${subcommand}".`);
}

module.exports = {
  execute
};
