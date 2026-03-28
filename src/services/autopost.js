const cron = require('node-cron');
const { PermissionFlagsBits } = require('discord.js');
const { DroqsDbApiError } = require('../api/droqsdbClient');
const {
  buildAutopostBucketEmbed,
  buildAutopostHighlightsEmbed,
  buildInfoEmbed,
  buildRunListEmbed
} = require('../utils/formatters');
const {
  AUTOPOST_MODES,
  buildAutopostFlightBucketSections,
  buildAutopostMixedHighlights,
  buildAutopostDescription,
  buildAutopostEmptyDescription,
  buildAutopostEmptyTitle,
  buildAutopostTitle,
  formatAutopostFilters,
  normalizeAutopostMode
} = require('../utils/autopost');

class AutopostService {
  constructor({
    discordClient,
    droqsdbClient,
    guildConfigStore,
    cronExpression,
    timezone,
    logger = console
  }) {
    this.discordClient = discordClient;
    this.droqsdbClient = droqsdbClient;
    this.guildConfigStore = guildConfigStore;
    this.cronExpression = cronExpression;
    this.timezone = timezone;
    this.logger = logger;
    this.job = null;
    this.isPosting = false;
  }

  async start() {
    if (this.job) {
      return;
    }

    await this.guildConfigStore.initialize();

    this.job = cron.schedule(
      this.cronExpression,
      async () => {
        await this.postHourlyRuns();
      },
      {
        timezone: this.timezone
      }
    );

    this.logger.info('autopost.scheduler_started', {
      cronExpression: this.cronExpression,
      timezone: this.timezone
    });
  }

  stop() {
    if (this.job) {
      this.job.stop();

      if (typeof this.job.destroy === 'function') {
        this.job.destroy();
      }

      this.job = null;
    }

    this.guildConfigStore.close();
    this.logger.info('autopost.scheduler_stopped');
  }

  async enable({
    guildId,
    channelId,
    count,
    mode = AUTOPOST_MODES.COUNT,
    country = null,
    category = null,
    updatedBy
  }) {
    return this.guildConfigStore.saveGuildAutopostConfig({
      guildId,
      channelId,
      count,
      mode,
      country,
      category,
      updatedBy
    });
  }

  async disable({
    guildId,
    updatedBy = null
  }) {
    return this.guildConfigStore.disableGuildAutopost({
      guildId,
      updatedBy
    });
  }

  getGuildConfig(guildId) {
    return this.guildConfigStore.getGuildConfig(guildId);
  }

  async postHourlyRuns() {
    if (this.isPosting) {
      this.logger.warn('autopost.overlap_skipped');
      return;
    }

    this.isPosting = true;

    try {
      const guildConfigs = await this.guildConfigStore.listEnabledGuildConfigs();

      if (!guildConfigs.length) {
        this.logger.info('autopost.run_skipped_no_guilds');
        return;
      }

      this.logger.info('autopost.run_started', {
        guildCount: guildConfigs.length
      });

      for (const guildConfig of guildConfigs) {
        try {
          await this.postForGuild(guildConfig);
        } catch (error) {
          this.logger.error('autopost.guild_unexpected_failure', error, this.describeGuildConfig(guildConfig));
        }
      }

      this.logger.info('autopost.run_finished', {
        guildCount: guildConfigs.length
      });
    } finally {
      this.isPosting = false;
    }
  }

  async postForGuild(guildConfig) {
    const channel = await this.resolveChannel(guildConfig);

    if (!channel) {
      return;
    }

    let payload;
    const mode = normalizeAutopostMode(guildConfig.mode);

    try {
      payload =
        mode === AUTOPOST_MODES.COUNT
          ? await this.droqsdbClient.getCurrentRunsForFilters({
              count: guildConfig.count,
              country: guildConfig.country,
              category: guildConfig.category
            })
          : await this.droqsdbClient.getCurrentRunUniverseForFilters({
              country: guildConfig.country,
              category: guildConfig.category
            });
    } catch (error) {
      if (error instanceof DroqsDbApiError && (error.upstreamUnavailable || error.retryable)) {
        this.logger.warn(
          'autopost.fetch_skipped_upstream_unavailable',
          error,
          this.describeGuildConfig(guildConfig)
        );
        return;
      }

      this.logger.error('autopost.fetch_failed', error, this.describeGuildConfig(guildConfig));
      return;
    }

    const targetCountry = payload.country || guildConfig.country;
    const targetCategory = payload.category || guildConfig.category;
    const embed = payload.runs.length
      ? this.buildAutopostEmbed({
          mode,
          payload,
          targetCountry,
          targetCategory,
          count: guildConfig.count
        })
      : buildInfoEmbed(
          buildAutopostEmptyTitle({
            country: targetCountry,
            category: targetCategory
          }),
          buildAutopostEmptyDescription({
            country: targetCountry,
            category: targetCategory
          }),
          { url: this.droqsdbClient.webBaseUrl }
        );

    try {
      await channel.send({
        embeds: [embed]
      });

      this.logger.info('autopost.posted', this.describeGuildConfig(guildConfig));
    } catch (error) {
      this.logger.error('autopost.post_failed', error, this.describeGuildConfig(guildConfig));

      if ([10003, 50001, 50013].includes(Number(error.code))) {
        await this.disableInvalidConfig(
          guildConfig,
          `post failed with Discord error code ${error.code}`
        );
      }
    }
  }

  async resolveChannel(guildConfig) {
    if (!guildConfig.channelId) {
      await this.disableInvalidConfig(guildConfig, 'no channel is configured');
      return null;
    }

    let channel;

    try {
      channel = await this.discordClient.channels.fetch(guildConfig.channelId);
    } catch (error) {
      this.logger.error('autopost.channel_fetch_failed', error, this.describeGuildConfig(guildConfig));

      if ([10003, 50001, 50013].includes(Number(error.code))) {
        await this.disableInvalidConfig(
          guildConfig,
          `channel fetch failed with Discord error code ${error.code}`
        );
      }

      return null;
    }

    if (!channel || !channel.isTextBased() || typeof channel.send !== 'function') {
      await this.disableInvalidConfig(guildConfig, 'configured channel is no longer text-sendable');
      return null;
    }

    if (channel.guildId !== guildConfig.guildId) {
      await this.disableInvalidConfig(guildConfig, 'configured channel no longer belongs to the guild');
      return null;
    }

    const permissions =
      typeof channel.permissionsFor === 'function' && this.discordClient.user?.id
        ? channel.permissionsFor(this.discordClient.user.id)
        : null;
    const missingPermissions = permissions
      ? REQUIRED_AUTOPOST_PERMISSIONS.filter((permission) => !permissions.has(permission, true))
      : REQUIRED_AUTOPOST_PERMISSIONS.slice();

    if (missingPermissions.length) {
      await this.disableInvalidConfig(
        guildConfig,
        `missing permissions: ${missingPermissions.map(formatPermissionName).join(', ')}`
      );
      return null;
    }

    return channel;
  }

  async disableInvalidConfig(guildConfig, reason) {
    this.logger.warn('autopost.config_disabled', {
      ...this.describeGuildConfig(guildConfig),
      reason
    });

    await this.disable({
      guildId: guildConfig.guildId,
      updatedBy: 'system'
    });
  }

  describeGuildConfig(guildConfig) {
    return {
      channelId: guildConfig.channelId || null,
      count: guildConfig.count,
      filters: formatAutopostFilters(guildConfig),
      mode: normalizeAutopostMode(guildConfig.mode),
      guildId: guildConfig.guildId
    };
  }

  buildAutopostEmbed({
    mode,
    payload,
    targetCountry,
    targetCategory,
    count
  }) {
    if (mode === AUTOPOST_MODES.FLIGHT_BUCKETS) {
      return buildAutopostBucketEmbed({
        title: buildAutopostTitle({
          mode,
          country: targetCountry,
          category: targetCategory
        }),
        description: buildAutopostDescription({
          mode,
          country: targetCountry,
          category: targetCategory
        }),
        sections: buildAutopostFlightBucketSections(payload.runs, 3),
        generatedAt: payload.generatedAt,
        url: this.droqsdbClient.webBaseUrl
      });
    }

    if (mode === AUTOPOST_MODES.MIXED_HIGHLIGHTS) {
      return buildAutopostHighlightsEmbed({
        title: buildAutopostTitle({
          mode,
          country: targetCountry,
          category: targetCategory
        }),
        description: buildAutopostDescription({
          mode,
          country: targetCountry,
          category: targetCategory
        }),
        highlights: buildAutopostMixedHighlights(payload.runs),
        generatedAt: payload.generatedAt,
        url: this.droqsdbClient.webBaseUrl
      });
    }

    return buildRunListEmbed({
      title: buildAutopostTitle({
        mode,
        country: targetCountry,
        category: targetCategory,
        count: payload.runs.length
      }),
      description: buildAutopostDescription({
        mode,
        country: targetCountry,
        category: targetCategory
      }),
      runs: payload.runs,
      generatedAt: payload.generatedAt,
      url: this.droqsdbClient.webBaseUrl,
      activeSellTarget: 'market'
    });
  }
}

const REQUIRED_AUTOPOST_PERMISSIONS = Object.freeze([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks
]);

function formatPermissionName(permission) {
  switch (permission) {
    case PermissionFlagsBits.ViewChannel:
      return 'ViewChannel';
    case PermissionFlagsBits.SendMessages:
      return 'SendMessages';
    case PermissionFlagsBits.EmbedLinks:
      return 'EmbedLinks';
    default:
      return String(permission);
  }
}

module.exports = {
  AutopostService
};
