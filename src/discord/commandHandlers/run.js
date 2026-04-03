const {
  buildRunEmptyStateGuidanceEmbed
} = require('../../utils/formatters');
const {
  buildBestRunEmbed,
  buildGuidanceRun,
  buildRunListEmbed
} = require('../../utils/runEmbeds');
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

function getSourceLabelForApiPath(apiPath) {
  return apiPath === '/api/companion/v1/travel-planner/query'
    ? 'DroqsDB Companion API'
    : 'DroqsDB Public API';
}

function getGuidedRuns(payload, count = Number.MAX_SAFE_INTEGER) {
  return Array.isArray(payload?.guidedRuns)
    ? payload.guidedRuns.slice(0, Math.max(0, count))
    : [];
}

function buildGuidedRunList({
  title,
  description,
  payload,
  runs,
  context,
  scopeCountry = null,
  scopeCategory = null
}) {
  return buildRunListEmbed({
    title,
    description,
    runs,
    generatedAt: payload.generatedAt,
    url: context.config.droqsdbWebBaseUrl,
    sourceLabel: getSourceLabelForApiPath(payload.apiPath),
    scopeCountry,
    scopeCategory
  });
}

function buildRunDisplayKey(run) {
  return `${String(run?.itemName || '').trim().toLowerCase()}::${String(run?.country || '').trim().toLowerCase()}`;
}

function getFallbackRuns({
  guidedRuns = [],
  guidance = null,
  count = Number.MAX_SAFE_INTEGER,
  minimumEntries = 1
}) {
  const normalizedCount = Number.isFinite(Number(count))
    ? Math.max(0, Math.floor(Number(count)))
    : Number.MAX_SAFE_INTEGER;
  const fallbackRuns = Array.isArray(guidedRuns) ? guidedRuns.slice(0, normalizedCount) : [];
  const guidanceRun = buildGuidanceRun(guidance);
  const requiredEntries = Math.max(0, Math.min(normalizedCount, Math.floor(minimumEntries)));

  if (
    !guidanceRun ||
    fallbackRuns.length >= normalizedCount ||
    fallbackRuns.length >= requiredEntries
  ) {
    return fallbackRuns;
  }

  const seenRunKeys = new Set(fallbackRuns.map(buildRunDisplayKey));

  if (!seenRunKeys.has(buildRunDisplayKey(guidanceRun))) {
    fallbackRuns.push(guidanceRun);
  }

  return fallbackRuns;
}

async function execute(interaction, context) {
  const subcommand = interaction.options.getSubcommand();
  await interaction.deferReply();

  if (subcommand === 'best') {
    const payload = await context.droqsdbClient.getCurrentRunsForFilters({
      count: 1
    });
    const bestRun = payload.runs[0];
    const fallbackRuns = getFallbackRuns({
      guidedRuns: getGuidedRuns(payload, 1),
      guidance: payload.emptyStateGuidance,
      count: 1,
      minimumEntries: 1
    });

    if (!bestRun) {
      if (fallbackRuns.length) {
        await interaction.editReply({
          embeds: [
            buildGuidedRunList({
              title: 'Next Guided Departure',
              description:
                'No profitable runs are live right now. This is the next backend-guided profitable departure.',
              payload,
              runs: fallbackRuns,
              context
            })
          ]
        });
        return;
      }

      await interaction.editReply({
        embeds: [
          await buildEmptyRunEmbed({
            context,
            title: 'No Best Run Available',
            fallbackDescription: 'DroqsDB does not currently report any profitable viable runs.',
            guidance: payload.emptyStateGuidance,
            generatedAt: payload.generatedAt,
            sourceLabel: getSourceLabelForApiPath(payload.apiPath),
            allowCompanionFallback: true,
            companionGuidanceFilters: {}
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
          sourceLabel: getSourceLabelForApiPath(payload.apiPath)
        })
      ]
    });
    return;
  }

  if (subcommand === 'top') {
    const count = interaction.options.getInteger('count', true);
    const payload = await context.droqsdbClient.getCurrentRunsForFilters({
      count
    });
    const runs = payload.runs;
    const fallbackRuns = getFallbackRuns({
      guidedRuns: getGuidedRuns(payload, count),
      guidance: payload.emptyStateGuidance,
      count,
      minimumEntries: Math.min(count, 3)
    });

    if (!runs.length) {
      if (fallbackRuns.length) {
        await interaction.editReply({
          embeds: [
            buildGuidedRunList({
              title:
                fallbackRuns.length === 1
                  ? 'Next Guided Departure'
                  : `Next ${fallbackRuns.length} Guided Departures`,
              description:
                'No profitable runs are live right now. These are the next backend-guided profitable departures from DroqsDB.',
              payload,
              runs: fallbackRuns,
              context
            })
          ]
        });
        return;
      }

      await interaction.editReply({
        embeds: [
          await buildEmptyRunEmbed({
            context,
            title: 'No Current Runs Available',
            fallbackDescription: 'DroqsDB does not currently report any profitable viable runs.',
            guidance: payload.emptyStateGuidance,
            generatedAt: payload.generatedAt,
            sourceLabel: getSourceLabelForApiPath(payload.apiPath),
            allowCompanionFallback: true,
            companionGuidanceFilters: {}
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
          sourceLabel: getSourceLabelForApiPath(payload.apiPath)
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
    const fallbackRuns = getFallbackRuns({
      guidedRuns: getGuidedRuns(payload, count),
      guidance: payload.emptyStateGuidance,
      count,
      minimumEntries: Math.min(count, 3)
    });

    if (!runs.length) {
      if (fallbackRuns.length) {
        await interaction.editReply({
          embeds: [
            buildGuidedRunList({
              title:
                fallbackRuns.length === 1
                  ? `Next ${sellTarget.titleLabel} Departure`
                  : `Next ${fallbackRuns.length} ${sellTarget.titleLabel} Departures`,
              description:
                `No profitable ${sellTarget.descriptionLabel} runs are live right now. These are the next backend-guided profitable departures.`,
              payload,
              runs: fallbackRuns,
              context
            })
          ]
        });
        return;
      }

      await interaction.editReply({
        embeds: [
          await buildEmptyRunEmbed({
            context,
            title: `No Current ${sellTarget.titleLabel} Runs Available`,
            fallbackDescription:
              `DroqsDB does not currently report any profitable viable runs for ${sellTarget.descriptionLabel} selling right now.`,
            guidance: payload.emptyStateGuidance,
            generatedAt: payload.generatedAt,
            sourceLabel: getSourceLabelForApiPath(payload.apiPath),
            allowCompanionFallback: true,
            companionGuidanceFilters: {
              sellWhere: target
            }
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
          sourceLabel: getSourceLabelForApiPath(payload.apiPath)
        })
      ]
    });
    return;
  }

  if (subcommand === 'country') {
    const country = interaction.options.getString('country', true);
    const count = interaction.options.getInteger('count', true);
    const payload = await context.droqsdbClient.getCurrentRunsByCountry(country, count);
    const fallbackRuns = getFallbackRuns({
      guidedRuns: getGuidedRuns(payload, count),
      guidance: payload.emptyStateGuidance,
      count,
      minimumEntries: Math.min(count, 3)
    });

    if (!payload.runs.length) {
      if (fallbackRuns.length) {
        await interaction.editReply({
          embeds: [
            buildGuidedRunList({
              title: `Next Runs for ${payload.country}`,
              description:
                'No profitable runs are live right now for that country. These are the next backend-guided profitable departures.',
              payload,
              runs: fallbackRuns,
              context,
              scopeCountry: payload.country
            })
          ]
        });
        return;
      }

      await interaction.editReply({
        embeds: [
          await buildEmptyRunEmbed({
            context,
            title: `No Current Runs for ${payload.country}`,
            fallbackDescription:
              'There are no currently profitable viable runs for that country right now.',
            guidance: payload.emptyStateGuidance,
            generatedAt: payload.generatedAt,
            sourceLabel: getSourceLabelForApiPath(payload.apiPath),
            allowCompanionFallback: true,
            companionGuidanceFilters: {
              country: payload.country
            }
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
          sourceLabel: getSourceLabelForApiPath(payload.apiPath),
          scopeCountry: payload.country
        })
      ]
    });
    return;
  }

  if (subcommand === 'item') {
    const itemName = interaction.options.getString('item', true);
    const payload = await context.droqsdbClient.getCurrentRunsByItem(itemName, 3);
    const fallbackRuns = getFallbackRuns({
      guidedRuns: getGuidedRuns(payload, 3),
      guidance: payload.emptyStateGuidance,
      count: 3,
      minimumEntries: 3
    });

    if (!payload.currentRuns.length) {
      if (fallbackRuns.length) {
        await interaction.editReply({
          embeds: [
            buildGuidedRunList({
              title: `Next Runs for ${payload.item.itemName}`,
              description:
                `${payload.item.category || 'Category unavailable'} - No profitable runs are live right now. These are the next backend-guided profitable departures.`,
              payload,
              runs: fallbackRuns,
              context,
              scopeCategory: payload.item.category
            })
          ]
        });
        return;
      }

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
            sourceLabel: getSourceLabelForApiPath(payload.apiPath),
            allowCompanionFallback: true,
            companionGuidanceFilters: {
              itemName: payload.item.itemName
            }
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
          sourceLabel: getSourceLabelForApiPath(payload.apiPath),
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
    const fallbackRuns = getFallbackRuns({
      guidedRuns: getGuidedRuns(payload, count),
      guidance: payload.emptyStateGuidance,
      count,
      minimumEntries: Math.min(count, 3)
    });

    if (!payload.runs.length) {
      if (fallbackRuns.length) {
        await interaction.editReply({
          embeds: [
            buildGuidedRunList({
              title:
                fallbackRuns.length === 1
                  ? `Next ${categoryLabel(payload.category)} Departure`
                  : `Next ${categoryLabel(payload.category)} Departures`,
              description:
                'No profitable runs are live right now in that category. These are the next backend-guided profitable departures.',
              payload,
              runs: fallbackRuns,
              context,
              scopeCategory: payload.category
            })
          ]
        });
        return;
      }

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
          sourceLabel: getSourceLabelForApiPath(payload.apiPath),
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
