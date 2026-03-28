const cron = require('node-cron');
const { PermissionFlagsBits } = require('discord.js');
const { DroqsDbApiError } = require('../api/droqsdbClient');
const {
  buildAutopostSectionsEmbed,
  buildRunEmptyStateGuidanceEmbed
} = require('../utils/formatters');
const {
  AUTOPOST_MODES,
  buildAutopostDescription,
  buildAutopostEmptyDescription,
  buildAutopostEmptyTitle,
  buildAutopostSections,
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

  async start(context = {}) {
    await this.guildConfigStore.initialize();

    if (this.job) {
      this.logSchedulerState('autopost.scheduler_already_running', context);
      return;
    }

    this.job = cron.schedule(
      this.cronExpression,
      async (executionContext) => {
        await this.postHourlyRuns(buildSchedulerRunContext(executionContext));
      },
      {
        name: 'autopost_hourly',
        timezone: this.timezone
      }
    );

    this.attachJobListeners();
    this.logSchedulerState('autopost.scheduler_started', context);
  }

  stop() {
    const enabledGuildCount = this.safeCountEnabledGuilds();
    const nextScheduledAt = this.getNextScheduledAt();

    if (this.job) {
      this.job.stop();

      if (typeof this.job.destroy === 'function') {
        this.job.destroy();
      }

      this.job = null;
    }

    this.guildConfigStore.close();
    this.logger.info('autopost.scheduler_stopped', {
      enabledGuildCount,
      nextScheduledAt
    });
  }

  async enable({
    guildId,
    channelId,
    count,
    mode = AUTOPOST_MODES.TOP_N,
    countries = [],
    categories = [],
    country = null,
    category = null,
    updatedBy
  }) {
    await this.ensureSchedulerRunning({
      guildId: String(guildId),
      reason: 'enable',
      requestedBy: updatedBy ? String(updatedBy) : null
    });

    const guildConfig = this.guildConfigStore.saveGuildAutopostConfig({
      guildId,
      channelId,
      count,
      mode,
      countries,
      categories,
      country,
      category,
      updatedBy
    });

    this.logSchedulerState('autopost.scheduler_refreshed', {
      ...this.describeGuildConfig(guildConfig),
      reason: 'enable',
      requestedBy: updatedBy ? String(updatedBy) : null
    });

    return guildConfig;
  }

  async disable({
    guildId,
    updatedBy = null
  }) {
    await this.guildConfigStore.initialize();

    const guildConfig = this.guildConfigStore.disableGuildAutopost({
      guildId,
      updatedBy
    });

    this.logSchedulerState('autopost.scheduler_refreshed', {
      guildId: String(guildId),
      reason: 'disable',
      requestedBy: updatedBy ? String(updatedBy) : null
    });

    return guildConfig;
  }

  getGuildConfig(guildId) {
    return this.guildConfigStore.getGuildConfig(guildId);
  }

  async postHourlyRuns(runContext = {}) {
    const runLogContext = {
      ...buildRunLogContext(runContext),
      nextScheduledAt: this.getNextScheduledAt()
    };

    if (this.isPosting) {
      this.logger.warn('autopost.overlap_skipped', runLogContext);
      return;
    }

    this.isPosting = true;

    try {
      const guildConfigs = await this.guildConfigStore.listEnabledGuildConfigs();

      if (!guildConfigs.length) {
        this.logger.info('autopost.run_skipped_no_guilds', runLogContext);
        return;
      }

      this.logger.info('autopost.run_started', {
        ...runLogContext,
        guildCount: guildConfigs.length
      });

      for (const guildConfig of guildConfigs) {
        try {
          await this.postForGuild(guildConfig, runContext);
        } catch (error) {
          this.logger.error('autopost.guild_unexpected_failure', error, {
            ...this.describeGuildConfig(guildConfig),
            ...buildRunLogContext(runContext)
          });
        }
      }

      this.logger.info('autopost.run_finished', {
        ...buildRunLogContext(runContext),
        guildCount: guildConfigs.length,
        nextScheduledAt: this.getNextScheduledAt()
      });
    } catch (error) {
      this.logger.error('autopost.run_failed', error, runLogContext);
      throw error;
    } finally {
      this.isPosting = false;
    }
  }

  async postForGuild(guildConfig, runContext = {}) {
    const activeGuildConfig = this.guildConfigStore.getGuildConfig(guildConfig.guildId);

    if (!activeGuildConfig?.autopostEnabled) {
      this.logger.info('autopost.guild_skipped_disabled', {
        guildId: guildConfig.guildId,
        ...buildRunLogContext(runContext)
      });
      return;
    }

    const channel = await this.resolveChannel(activeGuildConfig, runContext);

    if (!channel) {
      return;
    }

    let payload;
    const mode = normalizeAutopostMode(activeGuildConfig.mode);

    this.logger.info('autopost.post_attempt', {
      ...this.describeGuildConfig(activeGuildConfig),
      ...buildRunLogContext(runContext),
      targetChannelId: channel.id
    });

    try {
      payload =
        mode === AUTOPOST_MODES.TOP_N
          ? await this.droqsdbClient.getCurrentRunsForFilters({
              count: activeGuildConfig.count,
              countries: activeGuildConfig.countries,
              categories: activeGuildConfig.categories
            })
          : await this.droqsdbClient.getCurrentRunUniverseForFilters({
              countries: activeGuildConfig.countries,
              categories: activeGuildConfig.categories
            });
    } catch (error) {
      if (error instanceof DroqsDbApiError && (error.upstreamUnavailable || error.retryable)) {
        this.logger.warn('autopost.fetch_skipped_upstream_unavailable', error, {
          ...this.describeGuildConfig(activeGuildConfig),
          ...buildRunLogContext(runContext)
        });
        return;
      }

      this.logger.error('autopost.fetch_failed', error, {
        ...this.describeGuildConfig(activeGuildConfig),
        ...buildRunLogContext(runContext)
      });
      return;
    }

    const runs = Array.isArray(payload?.runs) ? payload.runs : [];

    if (!Array.isArray(payload?.runs)) {
      this.logger.warn('autopost.payload_runs_missing', {
        ...this.describeGuildConfig(activeGuildConfig),
        ...buildRunLogContext(runContext),
        apiPath: payload?.apiPath || null
      });
    }

    const normalizedPayload = {
      ...payload,
      runs
    };
    const targetCountries = normalizedPayload.countries?.length
      ? normalizedPayload.countries
      : activeGuildConfig.countries;
    const targetCategories = normalizedPayload.categories?.length
      ? normalizedPayload.categories
      : activeGuildConfig.categories;

    if (!runs.length) {
      this.logger.info('autopost.post_no_runs', {
        ...this.describeGuildConfig(activeGuildConfig),
        ...buildRunLogContext(runContext),
        apiPath: normalizedPayload.apiPath || null,
        emptyStateKind: getEmptyStateKind(normalizedPayload.emptyStateGuidance)
      });
    }

    let embed;

    try {
      embed = runs.length
        ? this.buildAutopostEmbed({
            mode,
            payload: normalizedPayload,
            targetCountries,
            targetCategories,
            count: activeGuildConfig.count
          })
        : buildRunEmptyStateGuidanceEmbed({
            title: buildAutopostEmptyTitle({
              countries: targetCountries,
              categories: targetCategories
            }),
            fallbackDescription: buildAutopostEmptyDescription({
              countries: targetCountries,
              categories: targetCategories
            }),
            guidance: normalizedPayload.emptyStateGuidance || null,
            generatedAt: normalizedPayload.generatedAt,
            sourceLabel: 'DroqsDB Public API',
            url: this.droqsdbClient.webBaseUrl
          });
    } catch (error) {
      this.logger.error('autopost.embed_build_failed', error, {
        ...this.describeGuildConfig(activeGuildConfig),
        ...buildRunLogContext(runContext),
        apiPath: normalizedPayload.apiPath || null,
        emptyStateKind: getEmptyStateKind(normalizedPayload.emptyStateGuidance),
        resultCount: runs.length
      });
      return;
    }

    try {
      await channel.send({
        embeds: [embed]
      });

      this.logger.info('autopost.posted', {
        ...this.describeGuildConfig(activeGuildConfig),
        ...buildRunLogContext(runContext),
        apiPath: normalizedPayload.apiPath || null,
        emptyStateKind: runs.length ? null : getEmptyStateKind(normalizedPayload.emptyStateGuidance),
        resultCount: runs.length
      });
    } catch (error) {
      this.logger.error('autopost.post_failed', error, {
        ...this.describeGuildConfig(activeGuildConfig),
        ...buildRunLogContext(runContext),
        apiPath: normalizedPayload.apiPath || null,
        emptyStateKind: runs.length ? null : getEmptyStateKind(normalizedPayload.emptyStateGuidance),
        resultCount: runs.length
      });

      if ([10003, 50001, 50013].includes(Number(error.code))) {
        await this.disableInvalidConfig(
          activeGuildConfig,
          `post failed with Discord error code ${error.code}`,
          runContext
        );
      }
    }
  }

  async resolveChannel(guildConfig, runContext = {}) {
    if (!guildConfig.channelId) {
      await this.disableInvalidConfig(guildConfig, 'no channel is configured', runContext);
      return null;
    }

    let channel;

    try {
      channel = await this.discordClient.channels.fetch(guildConfig.channelId);
    } catch (error) {
      this.logger.error('autopost.channel_fetch_failed', error, {
        ...this.describeGuildConfig(guildConfig),
        ...buildRunLogContext(runContext)
      });

      if ([10003, 50001, 50013].includes(Number(error.code))) {
        await this.disableInvalidConfig(
          guildConfig,
          `channel fetch failed with Discord error code ${error.code}`,
          runContext
        );
      }

      return null;
    }

    if (!channel || !channel.isTextBased() || typeof channel.send !== 'function') {
      await this.disableInvalidConfig(
        guildConfig,
        'configured channel is no longer text-sendable',
        runContext
      );
      return null;
    }

    if (channel.guildId !== guildConfig.guildId) {
      await this.disableInvalidConfig(
        guildConfig,
        'configured channel no longer belongs to the guild',
        runContext
      );
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
        `missing permissions: ${missingPermissions.map(formatPermissionName).join(', ')}`,
        runContext
      );
      return null;
    }

    return channel;
  }

  async disableInvalidConfig(guildConfig, reason, runContext = {}) {
    this.logger.warn('autopost.config_disabled', {
      ...this.describeGuildConfig(guildConfig),
      ...buildRunLogContext(runContext),
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
    targetCountries,
    targetCategories,
    count
  }) {
    return buildAutopostSectionsEmbed({
      title: buildAutopostTitle({
        mode,
        count
      }),
      description: buildAutopostDescription({
        mode,
        count,
        countries: targetCountries,
        categories: targetCategories
      }),
      sections: buildAutopostSections({
        mode,
        runs: payload.runs,
        count
      }),
      generatedAt: payload.generatedAt,
      url: this.droqsdbClient.webBaseUrl
    });
  }

  async ensureSchedulerRunning(context = {}) {
    await this.guildConfigStore.initialize();

    if (!this.job) {
      await this.start({
        ...context,
        recoveredFromMissingJob: true
      });
    }
  }

  attachJobListeners() {
    if (!this.job || typeof this.job.on !== 'function') {
      return;
    }

    this.job.on('execution:missed', (executionContext) => {
      this.logger.warn('autopost.scheduler_missed_execution', {
        ...buildSchedulerRunContext(executionContext),
        nextScheduledAt: this.getNextScheduledAt()
      });
    });

    this.job.on('execution:overlap', (executionContext) => {
      this.logger.warn('autopost.scheduler_overlap', {
        ...buildSchedulerRunContext(executionContext),
        nextScheduledAt: this.getNextScheduledAt()
      });
    });

    this.job.on('execution:failed', (executionContext) => {
      const error = executionContext?.execution?.error || new Error('Autopost scheduler execution failed.');

      this.logger.error('autopost.scheduler_execution_failed', error, {
        ...buildSchedulerRunContext(executionContext),
        nextScheduledAt: this.getNextScheduledAt()
      });
    });
  }

  safeCountEnabledGuilds() {
    try {
      return this.guildConfigStore.listEnabledGuildConfigs().length;
    } catch (error) {
      return null;
    }
  }

  getNextScheduledAt() {
    if (!this.job || typeof this.job.getNextRun !== 'function') {
      return null;
    }

    return normalizeLogTimestamp(this.job.getNextRun());
  }

  getJobStatus() {
    if (!this.job) {
      return 'stopped';
    }

    if (typeof this.job.getStatus === 'function') {
      return this.job.getStatus();
    }

    return 'scheduled';
  }

  logSchedulerState(message, context = {}) {
    this.logger.info(message, {
      cronExpression: this.cronExpression,
      enabledGuildCount: this.safeCountEnabledGuilds(),
      jobStatus: this.getJobStatus(),
      nextScheduledAt: this.getNextScheduledAt(),
      timezone: this.timezone,
      ...context
    });
  }
}

const REQUIRED_AUTOPOST_PERMISSIONS = Object.freeze([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks
]);

function buildSchedulerRunContext(executionContext = {}) {
  return {
    scheduledFor: normalizeLogTimestamp(executionContext.dateLocalIso || executionContext.date),
    triggeredAt: normalizeLogTimestamp(executionContext.triggeredAt)
  };
}

function buildRunLogContext(runContext = {}) {
  return {
    scheduledFor: normalizeLogTimestamp(runContext.scheduledFor),
    triggeredAt: normalizeLogTimestamp(runContext.triggeredAt)
  };
}

function normalizeLogTimestamp(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  const normalized = String(value).trim();
  return normalized || null;
}

function getEmptyStateKind(guidance) {
  const kind = String(guidance?.kind || guidance?.type || '')
    .trim()
    .toLowerCase();

  return kind || null;
}

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
