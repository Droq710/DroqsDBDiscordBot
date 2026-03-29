const {
  buildBestRunEmbed,
  buildRunEmptyStateGuidanceEmbed,
  buildRunListEmbed
} = require('../../utils/formatters');
const { categoryLabel } = require('../../constants/droqsdb');

const SELL_TARGET_CONFIG = Object.freeze({
  market: Object.freeze({
    titleLabel: 'Market',
    descriptionLabel: 'market'
  }),
  bazaar: Object.freeze({
    titleLabel: 'Bazaar',
    descriptionLabel: 'bazaar'
  }),
  torn: Object.freeze({
    titleLabel: 'Torn',
    descriptionLabel: 'Torn City Shops'
  })
});

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

function getPayloadRuns(payload) {
  if (Array.isArray(payload?.runs)) {
    return payload.runs;
  }

  return Array.isArray(payload?.items) ? payload.items : [];
}

function getSourceLabelForApiPath(apiPath) {
  return apiPath === '/api/companion/v1/travel-planner/query'
    ? 'DroqsDB Companion API'
    : 'DroqsDB Public API';
}

async function execute(interaction, context) {
  const subcommand = interaction.options.getSubcommand();
  await interaction.deferReply();

  if (subcommand === 'best') {
    const payload = await context.droqsdbClient.getTopRuns();
    const bestRun = getPayloadRuns(payload)[0];

    if (!bestRun) {
      await interaction.editReply({
        embeds: [
          await buildEmptyRunEmbed({
            context,
            title: 'No Best Run Available',
            fallbackDescription: 'DroqsDB does not currently report any profitable viable runs.',
            guidance: payload.emptyStateGuidance,
            generatedAt: payload.generatedAt,
            sourceLabel: getSourceLabelForApiPath(payload.apiPath)
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
    const runs = getPayloadRuns(payload).slice(0, count);

    if (!runs.length) {
      await interaction.editReply({
        embeds: [
          await buildEmptyRunEmbed({
            context,
            title: 'No Current Runs Available',
            fallbackDescription: 'DroqsDB does not currently report any profitable viable runs.',
            guidance: payload.emptyStateGuidance,
            generatedAt: payload.generatedAt,
            sourceLabel: getSourceLabelForApiPath(payload.apiPath)
          })
        ]
      });
      return;
    }

    await interaction.editReply({
      embeds: [
        buildRunListEmbed({
          title: `Top ${runs.length} Runs`,
          description: 'Current profitable viable runs from DroqsDB.',
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
    const payload = await context.droqsdbClient.getCurrentRunsForSellTarget(target, count);
    const sellTarget = getSellTargetConfig(target);
    const runs = payload.runs;

    if (!runs.length) {
      await interaction.editReply({
        embeds: [
          await buildEmptyRunEmbed({
            context,
            title: `No Current ${sellTarget.titleLabel} Runs Available`,
            fallbackDescription:
              `DroqsDB does not currently report any profitable viable runs for ${sellTarget.descriptionLabel} selling right now.`,
            guidance: payload.emptyStateGuidance,
            generatedAt: payload.generatedAt,
            sourceLabel: getSourceLabelForApiPath(payload.apiPath)
          })
        ]
      });
      return;
    }

    await interaction.editReply({
      embeds: [
        buildRunListEmbed({
          title: `Top ${runs.length} Runs (${sellTarget.titleLabel})`,
          description:
            `Current profitable viable runs ranked for ${sellTarget.descriptionLabel} selling.`,
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
              'There are no currently profitable viable runs for that country right now.',
            guidance: payload.emptyStateGuidance,
            generatedAt: payload.generatedAt,
            sourceLabel: getSourceLabelForApiPath(payload.apiPath)
          })
        ]
      });
      return;
    }

    await interaction.editReply({
      embeds: [
        buildRunListEmbed({
          title: `Top ${payload.runs.length} Runs for ${payload.country}`,
          description: 'Ranked using the current DroqsDB run snapshot.',
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
        ? `No currently profitable viable runs are available for ${payload.item.itemName}. The soonest tracked restock is ${fallback.country} at ${fallback.estimatedRestockDisplay}.`
        : `No currently profitable viable runs are available for ${payload.item.itemName}.`;

      await interaction.editReply({
        embeds: [
          await buildEmptyRunEmbed({
            context,
            title: `No Current Runs for ${payload.item.itemName}`,
            fallbackDescription: description,
            guidance: payload.emptyStateGuidance,
            generatedAt: payload.generatedAt,
            sourceLabel: getSourceLabelForApiPath(payload.apiPath)
          })
        ]
      });
      return;
    }

    await interaction.editReply({
      embeds: [
        buildRunListEmbed({
          title: `Best Current Runs for ${payload.item.itemName}`,
          description:
            `${payload.item.category || 'Category unavailable'} - Showing the best currently profitable viable countries.`,
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
              'There are no currently profitable viable runs in that category right now.',
            guidance: payload.emptyStateGuidance,
            generatedAt: payload.generatedAt,
            allowCompanionFallback: true,
            sourceLabel: getSourceLabelForApiPath(payload.apiPath),
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
          description: 'Ranked using the current DroqsDB tracked-category snapshot.',
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
