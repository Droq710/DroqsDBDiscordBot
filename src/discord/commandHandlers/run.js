const {
  buildBestRunEmbed,
  buildInfoEmbed,
  buildRunEmptyStateGuidanceEmbed,
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

async function buildEmptyRunEmbed({
  context,
  title,
  fallbackDescription,
  guidance = null,
  generatedAt = null,
  sourceLabel = 'DroqsDB Public API',
  allowCompanionFallback = false,
  companionGuidanceFilters = null
}) {
  let resolvedGuidance = guidance;
  let resolvedGeneratedAt = generatedAt;
  let resolvedSourceLabel = sourceLabel;

  if (
    allowCompanionFallback === true &&
    !hasGuidanceKind(resolvedGuidance) &&
    companionGuidanceFilters
  ) {
    try {
      const guidancePayload = await context.droqsdbClient.getRunEmptyStateGuidance(
        companionGuidanceFilters
      );

      if (hasGuidanceKind(guidancePayload?.emptyStateGuidance)) {
        resolvedGuidance = guidancePayload.emptyStateGuidance;
        resolvedGeneratedAt = guidancePayload.generatedAt || resolvedGeneratedAt;
        resolvedSourceLabel = 'DroqsDB Companion API';
      }
    } catch (error) {
      context.logger.warn('run.empty_state_guidance_failed', error, {
        guidanceFilters: companionGuidanceFilters
      });
    }
  }

  return buildRunEmptyStateGuidanceEmbed({
    title,
    fallbackDescription,
    guidance: resolvedGuidance,
    generatedAt: resolvedGeneratedAt,
    sourceLabel: resolvedSourceLabel,
    url: context.config.droqsdbWebBaseUrl
  });
}

function hasGuidanceKind(guidance) {
  return typeof guidance?.kind === 'string' && guidance.kind.trim().length > 0;
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
          await buildEmptyRunEmbed({
            context,
            title: 'No Best Run Available',
            fallbackDescription: 'DroqsDB does not currently report any profitable in-stock runs.',
            guidance: payload.emptyStateGuidance,
            generatedAt: payload.generatedAt
          })
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
          await buildEmptyRunEmbed({
            context,
            title: 'No Current Runs Available',
            fallbackDescription: 'DroqsDB does not currently report any profitable in-stock runs.',
            guidance: payload.emptyStateGuidance,
            generatedAt: payload.generatedAt
          })
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
          await buildEmptyRunEmbed({
            context,
            title: `No Current Runs for ${payload.country}`,
            fallbackDescription:
              'There are no currently profitable in-stock runs for that country right now.',
            guidance: payload.emptyStateGuidance,
            generatedAt: payload.generatedAt
          })
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
          activeSellTarget: 'market',
          scopeCountry: payload.country
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
          await buildEmptyRunEmbed({
            context,
            title: `No Current Runs for ${payload.item.itemName}`,
            fallbackDescription: description,
            guidance: payload.emptyStateGuidance,
            generatedAt: payload.generatedAt
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
          activeSellTarget: 'market',
          scopeCategory: payload.item.category
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
          await buildEmptyRunEmbed({
            context,
            title: `No Current ${categoryLabel(payload.category)} Runs`,
            fallbackDescription:
              'There are no currently profitable in-stock runs in that category right now.',
            generatedAt: payload.generatedAt,
            allowCompanionFallback: true,
            companionGuidanceFilters: {
              category: payload.category
            }
          })
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
          activeSellTarget: 'market',
          scopeCategory: payload.category
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
