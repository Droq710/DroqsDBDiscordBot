const cron = require('node-cron');
const { PermissionFlagsBits } = require('discord.js');
const { DroqsDbApiError } = require('../api/droqsdbClient');
const {
  buildAutopostSectionsEmbed,
  buildDailyForecastEmbed,
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
const {
  getTctDateKey,
  isDailyForecastDue,
  normalizeDailyForecastCount,
  normalizeDailyForecastTime
} = require('../utils/dailyForecast');

const AUTOPOST_FALLBACK_MESSAGE =
  '⚠️ DroqsDB data temporarily unavailable. Will try again next hour.';
const DEFAULT_DAILY_FORECAST_CRON = '* * * * *';
const DEFAULT_DAILY_FORECAST_TIMEZONE = 'UTC';

class AutopostService {
  constructor({
    discordClient,
    droqsdbClient,
    guildConfigStore,
    cronExpression,
    timezone,
    dailyForecastCronExpression = DEFAULT_DAILY_FORECAST_CRON,
    dailyForecastTimezone = DEFAULT_DAILY_FORECAST_TIMEZONE,
    logger = console
  }) {
    this.discordClient = discordClient;
    this.droqsdbClient = droqsdbClient;
    this.guildConfigStore = guildConfigStore;
    this.cronExpression = cronExpression;
    this.timezone = timezone;
    this.dailyForecastCronExpression = dailyForecastCronExpression;
    this.dailyForecastTimezone = dailyForecastTimezone;
    this.logger = logger;
    this.job = null;
    this.dailyForecastJob = null;
    this.isPosting = false;
    this.isPostingDailyForecast = false;
  }

  async start(context = {}) {
    await this.guildConfigStore.initialize();

    if (this.job && this.dailyForecastJob) {
      this.logSchedulerState('autopost.scheduler_already_running', context);
      return;
    }

    if (!this.job) {
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
    }

    if (!this.dailyForecastJob) {
      this.dailyForecastJob = cron.schedule(
        this.dailyForecastCronExpression,
        async (executionContext) => {
          await this.postDailyForecasts(buildSchedulerRunContext(executionContext));
        },
        {
          name: 'autopost_daily_forecast',
          timezone: this.dailyForecastTimezone
        }
      );

      this.attachDailyForecastJobListeners();
    }

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

    if (this.dailyForecastJob) {
      this.dailyForecastJob.stop();

      if (typeof this.dailyForecastJob.destroy === 'function') {
        this.dailyForecastJob.destroy();
      }

      this.dailyForecastJob = null;
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

  async enableDailyForecast({
    guildId,
    channelId,
    time,
    count,
    updatedBy
  }) {
    await this.ensureSchedulerRunning({
      guildId: String(guildId),
      reason: 'daily_forecast_enable',
      requestedBy: updatedBy ? String(updatedBy) : null
    });

    const guildConfig = this.guildConfigStore.saveGuildDailyForecastConfig({
      guildId,
      channelId,
      time,
      count,
      updatedBy
    });

    this.logSchedulerState('autopost.scheduler_refreshed', {
      ...this.describeDailyForecastConfig(guildConfig),
      reason: 'daily_forecast_enable',
      requestedBy: updatedBy ? String(updatedBy) : null
    });

    return guildConfig;
  }

  async disableDailyForecast({
    guildId,
    updatedBy = null
  }) {
    await this.guildConfigStore.initialize();

    const guildConfig = this.guildConfigStore.disableGuildDailyForecast({
      guildId,
      updatedBy
    });

    this.logSchedulerState('autopost.scheduler_refreshed', {
      guildId: String(guildId),
      reason: 'daily_forecast_disable',
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

  async postDailyForecasts(runContext = {}) {
    const runDate = resolveRunDate(runContext);
    const runLogContext = {
      ...buildRunLogContext(runContext),
      tctDate: getTctDateKey(runDate),
      nextScheduledAt: this.getNextDailyForecastScheduledAt()
    };

    if (this.isPostingDailyForecast) {
      this.logger.warn('daily_forecast.overlap_skipped', runLogContext);
      return;
    }

    this.isPostingDailyForecast = true;

    try {
      const guildConfigs = await this.guildConfigStore.listEnabledDailyForecastConfigs();
      const dueGuildConfigs = guildConfigs.filter((guildConfig) =>
        isDailyForecastDue(guildConfig, runDate)
      );

      if (!dueGuildConfigs.length) {
        this.logger.info('daily_forecast.run_skipped_no_due_guilds', {
          ...runLogContext,
          enabledGuildCount: guildConfigs.length
        });
        return;
      }

      this.logger.info('daily_forecast.run_started', {
        ...runLogContext,
        guildCount: dueGuildConfigs.length
      });

      for (const guildConfig of dueGuildConfigs) {
        try {
          await this.postDailyForecastForGuild(guildConfig, runContext);
        } catch (error) {
          this.logger.error('daily_forecast.guild_unexpected_failure', error, {
            ...this.describeDailyForecastConfig(guildConfig),
            ...buildRunLogContext(runContext)
          });
        }
      }

      this.logger.info('daily_forecast.run_finished', {
        ...runLogContext,
        guildCount: dueGuildConfigs.length,
        nextScheduledAt: this.getNextDailyForecastScheduledAt()
      });
    } catch (error) {
      this.logger.error('daily_forecast.run_failed', error, runLogContext);
      throw error;
    } finally {
      this.isPostingDailyForecast = false;
    }
  }

  async postDailyForecastForGuild(guildConfig, runContext = {}) {
    const activeGuildConfig = this.guildConfigStore.getGuildConfig(guildConfig.guildId);
    const runDate = resolveRunDate(runContext);

    if (!isDailyForecastDue(activeGuildConfig, runDate)) {
      this.logger.info('daily_forecast.guild_skipped_not_due', {
        guildId: guildConfig.guildId,
        ...buildRunLogContext(runContext)
      });
      return;
    }

    const channelConfig = {
      ...activeGuildConfig,
      channelId: activeGuildConfig.dailyForecastChannelId
    };
    const channel = await this.resolveChannel(channelConfig, runContext, {
      onInvalidConfig: (_invalidConfig, reason, invalidRunContext) =>
        this.disableInvalidDailyForecastConfig(activeGuildConfig, reason, invalidRunContext)
    });

    if (!channel) {
      return;
    }

    this.logger.info('daily_forecast.post_attempt', {
      ...this.describeDailyForecastConfig(activeGuildConfig),
      ...buildRunLogContext(runContext),
      targetChannelId: channel.id
    });

    const payload = await this.fetchDailyForecastPayload({
      guildConfig: activeGuildConfig,
      runContext,
      targetChannelId: channel.id
    });

    if (!payload) {
      return;
    }

    let embed;

    try {
      embed = buildDailyForecastEmbed({
        forecast: payload,
        count: activeGuildConfig.dailyForecastCount,
        url: this.droqsdbClient.webBaseUrl
      });
    } catch (error) {
      this.logger.error('daily_forecast.embed_build_failed', error, {
        ...this.describeDailyForecastConfig(activeGuildConfig),
        ...buildRunLogContext(runContext),
        apiPath: payload.apiPath || null,
        resultCount: Array.isArray(payload.items) ? payload.items.length : null
      });
      return;
    }

    try {
      await channel.send({
        embeds: [embed]
      });

      this.guildConfigStore.markDailyForecastPosted({
        guildId: activeGuildConfig.guildId,
        dateKey: getTctDateKey(runDate)
      });

      this.logger.info('daily_forecast.posted', {
        ...this.describeDailyForecastConfig(activeGuildConfig),
        ...buildRunLogContext(runContext),
        apiPath: payload.apiPath || null,
        resultCount: Array.isArray(payload.items) ? payload.items.length : 0
      });
    } catch (error) {
      this.logger.error('daily_forecast.post_failed', error, {
        ...this.describeDailyForecastConfig(activeGuildConfig),
        ...buildRunLogContext(runContext),
        apiPath: payload.apiPath || null,
        resultCount: Array.isArray(payload.items) ? payload.items.length : 0
      });

      if ([10003, 50001, 50013].includes(Number(error.code))) {
        await this.disableInvalidDailyForecastConfig(
          activeGuildConfig,
          `daily forecast post failed with Discord error code ${error.code}`,
          runContext
        );
      }
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

    payload = await this.fetchAutopostPayload({
      guildConfig: activeGuildConfig,
      mode,
      runContext,
      targetChannelId: channel.id
    });

    if (!payload) {
      await this.sendFallbackMessage(channel, activeGuildConfig, runContext, {
        reason: 'fetch_failed'
      });
      return;
    }

    if (!Array.isArray(payload?.runs)) {
      this.logger.warn('autopost.payload_runs_missing', {
        ...this.describeGuildConfig(activeGuildConfig),
        ...buildRunLogContext(runContext),
        apiPath: payload?.apiPath || null,
        targetChannelId: channel.id
      });
      await this.sendFallbackMessage(channel, activeGuildConfig, runContext, {
        apiPath: payload?.apiPath || null,
        reason: 'payload_runs_missing'
      });
      return;
    }

    const runs = payload.runs;
    const guidedRuns = Array.isArray(payload?.guidedRuns) ? payload.guidedRuns : [];
    const normalizedPayload = {
      ...payload,
      runs,
      guidedRuns
    };
    const targetCountries = normalizedPayload.countries?.length
      ? normalizedPayload.countries
      : activeGuildConfig.countries;
    const targetCategories = normalizedPayload.categories?.length
      ? normalizedPayload.categories
      : activeGuildConfig.categories;

    const hasDisplayableRuns =
      runs.length > 0 ||
      (mode === AUTOPOST_MODES.FULL_BREAKDOWN && guidedRuns.length > 0);

    if (!hasDisplayableRuns) {
      this.logger.info('autopost.post_no_runs', {
        ...this.describeGuildConfig(activeGuildConfig),
        ...buildRunLogContext(runContext),
        apiPath: normalizedPayload.apiPath || null,
        emptyStateKind: getEmptyStateKind(normalizedPayload.emptyStateGuidance)
      });
    }

    let embed;

    try {
      embed = hasDisplayableRuns
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
        emptyStateKind: hasDisplayableRuns ? null : getEmptyStateKind(normalizedPayload.emptyStateGuidance),
        resultCount: runs.length
      });
    } catch (error) {
      this.logger.error('autopost.post_failed', error, {
        ...this.describeGuildConfig(activeGuildConfig),
        ...buildRunLogContext(runContext),
        apiPath: normalizedPayload.apiPath || null,
        emptyStateKind: hasDisplayableRuns ? null : getEmptyStateKind(normalizedPayload.emptyStateGuidance),
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

  async fetchAutopostPayload({
    guildConfig,
    mode,
    runContext = {},
    targetChannelId = null
  }) {
    const fetchContext = {
      ...this.describeGuildConfig(guildConfig),
      ...buildRunLogContext(runContext),
      requestTimeoutMs: this.droqsdbClient.requestTimeoutMs,
      targetChannelId
    };
    const fetchRuns = () =>
      mode === AUTOPOST_MODES.TOP_N
        ? this.droqsdbClient.getCurrentRunsForFilters({
            count: guildConfig.count,
            countries: guildConfig.countries,
            categories: guildConfig.categories
          })
        : this.droqsdbClient.getCurrentRunUniverseForFilters({
            countries: guildConfig.countries,
            categories: guildConfig.categories
          });

    this.logger.info('autopost.fetch_attempt', {
      ...fetchContext,
      attempt: 1
    });

    try {
      return await fetchRuns();
    } catch (error) {
      if (!shouldRetryAutopostFetch(error)) {
        this.logger.error('autopost.fetch_failed_final', error, {
          ...fetchContext,
          attempts: 1,
          retried: false
        });
        return null;
      }

      this.logger.warn('autopost.fetch_retry', error, {
        ...fetchContext,
        nextAttempt: 2,
        previousAttempt: 1
      });

      try {
        return await fetchRuns();
      } catch (retryError) {
        this.logger.error('autopost.fetch_failed_final', retryError, {
          ...fetchContext,
          attempts: 2,
          retried: true
        });
        return null;
      }
    }
  }

  async fetchDailyForecastPayload({
    guildConfig,
    runContext = {},
    targetChannelId = null
  }) {
    const fetchContext = {
      ...this.describeDailyForecastConfig(guildConfig),
      ...buildRunLogContext(runContext),
      requestTimeoutMs: this.droqsdbClient.requestTimeoutMs,
      targetChannelId
    };
    const fetchForecast = () => this.droqsdbClient.getDailyForecast();

    this.logger.info('daily_forecast.fetch_attempt', {
      ...fetchContext,
      attempt: 1
    });

    try {
      return await fetchForecast();
    } catch (error) {
      if (!shouldRetryAutopostFetch(error)) {
        this.logger.error('daily_forecast.fetch_failed_final', error, {
          ...fetchContext,
          attempts: 1,
          retried: false
        });
        return null;
      }

      this.logger.warn('daily_forecast.fetch_retry', error, {
        ...fetchContext,
        nextAttempt: 2,
        previousAttempt: 1
      });

      try {
        return await fetchForecast();
      } catch (retryError) {
        this.logger.error('daily_forecast.fetch_failed_final', retryError, {
          ...fetchContext,
          attempts: 2,
          retried: true
        });
        return null;
      }
    }
  }

  async sendFallbackMessage(channel, guildConfig, runContext = {}, {
    apiPath = null,
    reason = 'fetch_failed'
  } = {}) {
    const logContext = {
      ...this.describeGuildConfig(guildConfig),
      ...buildRunLogContext(runContext),
      apiPath,
      reason,
      targetChannelId: channel?.id || null
    };

    this.logger.warn('autopost.fallback_started', logContext);

    try {
      await channel.send({
        content: AUTOPOST_FALLBACK_MESSAGE
      });

      this.logger.warn('autopost.fallback_completed', logContext);
    } catch (error) {
      this.logger.error('autopost.fallback_failed', error, logContext);

      if ([10003, 50001, 50013].includes(Number(error.code))) {
        try {
          await this.disableInvalidConfig(
            guildConfig,
            `fallback post failed with Discord error code ${error.code}`,
            runContext
          );
        } catch (disableError) {
          this.logger.error('autopost.fallback_failed', disableError, {
            ...logContext,
            failureStage: 'disable_invalid_config'
          });
        }
      }
    }
  }

  async resolveChannel(guildConfig, runContext = {}, {
    onInvalidConfig = (invalidConfig, reason, invalidRunContext) =>
      this.disableInvalidConfig(invalidConfig, reason, invalidRunContext)
  } = {}) {
    if (!guildConfig.channelId) {
      await onInvalidConfig(guildConfig, 'no channel is configured', runContext);
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
        await onInvalidConfig(
          guildConfig,
          `channel fetch failed with Discord error code ${error.code}`,
          runContext
        );
      }

      return null;
    }

    if (!channel || !channel.isTextBased() || typeof channel.send !== 'function') {
      await onInvalidConfig(
        guildConfig,
        'configured channel is no longer text-sendable',
        runContext
      );
      return null;
    }

    if (channel.guildId !== guildConfig.guildId) {
      await onInvalidConfig(
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
      await onInvalidConfig(
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

  async disableInvalidDailyForecastConfig(guildConfig, reason, runContext = {}) {
    this.logger.warn('daily_forecast.config_disabled', {
      ...this.describeDailyForecastConfig(guildConfig),
      ...buildRunLogContext(runContext),
      reason
    });

    await this.disableDailyForecast({
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

  describeDailyForecastConfig(guildConfig) {
    return {
      channelId: guildConfig.dailyForecastChannelId || null,
      count: normalizeDailyForecastCount(guildConfig.dailyForecastCount),
      guildId: guildConfig.guildId,
      postTime: normalizeDailyForecastTime(guildConfig.dailyForecastTime)
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
        guidedRuns: payload.guidedRuns,
        count
      }),
      generatedAt: payload.generatedAt,
      url: this.droqsdbClient.webBaseUrl
    });
  }

  async ensureSchedulerRunning(context = {}) {
    await this.guildConfigStore.initialize();

    if (!this.job || !this.dailyForecastJob) {
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

  attachDailyForecastJobListeners() {
    if (!this.dailyForecastJob || typeof this.dailyForecastJob.on !== 'function') {
      return;
    }

    this.dailyForecastJob.on('execution:missed', (executionContext) => {
      this.logger.warn('daily_forecast.scheduler_missed_execution', {
        ...buildSchedulerRunContext(executionContext),
        nextScheduledAt: this.getNextDailyForecastScheduledAt()
      });
    });

    this.dailyForecastJob.on('execution:overlap', (executionContext) => {
      this.logger.warn('daily_forecast.scheduler_overlap', {
        ...buildSchedulerRunContext(executionContext),
        nextScheduledAt: this.getNextDailyForecastScheduledAt()
      });
    });

    this.dailyForecastJob.on('execution:failed', (executionContext) => {
      const error =
        executionContext?.execution?.error || new Error('Daily forecast scheduler execution failed.');

      this.logger.error('daily_forecast.scheduler_execution_failed', error, {
        ...buildSchedulerRunContext(executionContext),
        nextScheduledAt: this.getNextDailyForecastScheduledAt()
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

  safeCountEnabledDailyForecastGuilds() {
    try {
      return this.guildConfigStore.listEnabledDailyForecastConfigs().length;
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

  getNextDailyForecastScheduledAt() {
    if (!this.dailyForecastJob || typeof this.dailyForecastJob.getNextRun !== 'function') {
      return null;
    }

    return normalizeLogTimestamp(this.dailyForecastJob.getNextRun());
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

  getDailyForecastJobStatus() {
    if (!this.dailyForecastJob) {
      return 'stopped';
    }

    if (typeof this.dailyForecastJob.getStatus === 'function') {
      return this.dailyForecastJob.getStatus();
    }

    return 'scheduled';
  }

  logSchedulerState(message, context = {}) {
    this.logger.info(message, {
      cronExpression: this.cronExpression,
      dailyForecastCronExpression: this.dailyForecastCronExpression,
      dailyForecastEnabledGuildCount: this.safeCountEnabledDailyForecastGuilds(),
      dailyForecastJobStatus: this.getDailyForecastJobStatus(),
      dailyForecastNextScheduledAt: this.getNextDailyForecastScheduledAt(),
      dailyForecastTimezone: this.dailyForecastTimezone,
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

function resolveRunDate(runContext = {}) {
  const candidates = [
    runContext.now,
    runContext.scheduledFor,
    runContext.triggeredAt
  ];

  for (const candidate of candidates) {
    const normalized = normalizeDate(candidate);

    if (normalized) {
      return normalized;
    }
  }

  return new Date();
}

function normalizeDate(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
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

function shouldRetryAutopostFetch(error) {
  return (
    error instanceof DroqsDbApiError &&
    (error.code === 'API_TIMEOUT' || error.upstreamUnavailable === true || Number(error.status) === 504)
  );
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
