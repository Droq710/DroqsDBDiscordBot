const cron = require('node-cron');
const { PermissionFlagsBits } = require('discord.js');
const {
  buildGiveawayEntryCooldownNoticeContent,
  buildExpiredGiveawayNoticeContent,
  buildGiveawayAnnouncementContent,
  buildGiveawayLeaderboardEmbed,
  buildGiveawayEmbed,
  extractTornIdFromText
} = require('../utils/giveawayFormatters');
const {
  DEFAULT_GIVEAWAY_WINNER_COOLDOWN_MS,
  GIVEAWAY_EMOJI,
  GIVEAWAY_END_MODE_ENTRIES,
  GIVEAWAY_END_MODE_TIME,
  formatDurationWords,
  isGiveawayExpired,
  normalizeEmojiName,
  normalizeGiveawayEndMode,
  normalizeGiveawayGameType,
  normalizeGiveawayMaxEntries,
  normalizeGiveawayMessageId,
  normalizeGiveawayWinnerCooldownEnabled,
  normalizeGiveawayWinnerCooldownMs
} = require('../utils/giveaway');
const { resolveGiveawayGame } = require('./giveawayGames');

const EXPIRED_REACTION_NOTICE_COOLDOWN_MS = 10 * 60 * 1000;
const EXPIRED_REACTION_FALLBACK_DELETE_DELAY_MS = 15_000;
const GIVEAWAYS_ROLE_NAME = 'Giveaways';
const RECENT_GIVEAWAY_ANNOUNCEMENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RECENT_GIVEAWAY_ANNOUNCEMENTS = 50;
const DEFAULT_PRIZE_DELIVERY_FORUM_URL =
  'https://www.torn.com/forums.php#/p=threads&f=14&t=16551076';
const RUSSIAN_ROULETTE_REVEAL_DELAY_MS = 1_250;
const RUSSIAN_ROULETTE_REVEAL_HEADING = 'Russian Roulette:';
const GIVEAWAY_LEADERBOARD_CRON = '0 23 * * *';
const GIVEAWAY_LEADERBOARD_TIMEZONE = 'UTC';
const GIVEAWAY_LEADERBOARD_CHANNEL_NAME = 'giveaways';
const GIVEAWAY_LEADERBOARD_LIMIT = 10;
const MAX_GIVEAWAY_TIMER_DELAY_MS = 24 * 60 * 60 * 1000;
const GENERIC_PRIZE_CONFIRMATION_PATTERNS = Object.freeze([
  /\b(?:prize|reward|winnings|payout|payment)\s+(?:was\s+|has\s+been\s+)?sent\b/i,
  /\bsent\s+(?:the\s+)?(?:prize|reward|winnings|payout|payment|cash|item|trade)\b/i,
  /\b(?:trade|payout|payment)\s+sent\b/i,
  /\b(?:prize|reward|winnings|payout|payment)\s+delivered\b/i,
  /\bpaid\s+out\b/i
]);
const TORN_PRIZE_CONFIRMATION_PATTERNS = Object.freeze([
  /^You(?:\s+have)?\s+sent\s+(.+?)\s+to\s+(.+?)(?:\s+with\s+the\s+message:\s+(.+))?[.!]?$/i
]);
const TORN_PRIZE_CONFIRMATION_PREFIX_PATTERN =
  /^\d{1,2}:\d{2}:\d{2}\s*-\s*\d{1,2}\/\d{1,2}\/\d{2,4}\s+/;

class GiveawayService {
  constructor({
    discordClient,
    giveawayStore,
    logger = console,
    prizeDeliveryForumUrl = process.env.GIVEAWAY_PRIZE_DELIVERY_FORUM_URL || DEFAULT_PRIZE_DELIVERY_FORUM_URL,
    russianRouletteRevealDelayMs = RUSSIAN_ROULETTE_REVEAL_DELAY_MS,
    delayFn = delay
  }) {
    this.discordClient = discordClient;
    this.giveawayStore = giveawayStore;
    this.logger = logger;
    this.prizeDeliveryForumUrl = String(prizeDeliveryForumUrl || '').trim() || DEFAULT_PRIZE_DELIVERY_FORUM_URL;
    this.russianRouletteRevealDelayMs = Math.max(
      0,
      Math.floor(Number(russianRouletteRevealDelayMs) || RUSSIAN_ROULETTE_REVEAL_DELAY_MS)
    );
    this.delayFn = typeof delayFn === 'function' ? delayFn : delay;
    this.timers = new Map();
    this.inFlightMessageIds = new Set();
    this.entryCloseSnapshots = new Map();
    this.reactionNoticeCooldowns = new Map();
    this.recentGiveawayAnnouncements = new Map();
    this.leaderboardJob = null;
    this.isPostingLeaderboard = false;
    this.started = false;
  }

  async start() {
    if (this.started) {
      return;
    }

    await this.giveawayStore.initialize();

    const pendingGiveaways = this.giveawayStore.listPendingGiveaways();

    for (const giveaway of pendingGiveaways) {
      this.scheduleGiveaway(giveaway);
    }

    await Promise.allSettled(
      pendingGiveaways
        .filter(
          (giveaway) =>
            giveaway.status === 'active' &&
            normalizeGiveawayEndMode(giveaway.endMode) === GIVEAWAY_END_MODE_ENTRIES
        )
        .map((giveaway) => this.recoverEntryModeGiveaway(giveaway))
    );

    this.ensureLeaderboardSchedulerRunning();

    this.started = true;
    this.logger.info('giveaway.scheduler_started', {
      pendingGiveawayCount: pendingGiveaways.length
    });
  }

  stop() {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }

    this.timers.clear();
    this.inFlightMessageIds.clear();
    this.entryCloseSnapshots.clear();
    this.reactionNoticeCooldowns.clear();
    this.recentGiveawayAnnouncements.clear();
    this.stopLeaderboardScheduler();
    this.giveawayStore.close();
    this.started = false;
    this.logger.info('giveaway.scheduler_stopped');
  }

  getGiveaway(messageId) {
    return this.giveawayStore.getGiveawayByMessageId(messageId);
  }

  getLeaderboard(guildId, {
    limit = GIVEAWAY_LEADERBOARD_LIMIT
  } = {}) {
    return this.giveawayStore.listGiveawayLeaderboard(guildId, {
      limit
    });
  }

  ensureLeaderboardSchedulerRunning() {
    if (this.leaderboardJob) {
      return;
    }

    this.leaderboardJob = cron.schedule(
      GIVEAWAY_LEADERBOARD_CRON,
      async (executionContext) => {
        await this.postDailyLeaderboard(buildLeaderboardSchedulerRunContext(executionContext));
      },
      {
        name: 'giveaway_leaderboard_daily',
        timezone: GIVEAWAY_LEADERBOARD_TIMEZONE
      }
    );

    this.attachLeaderboardJobListeners();
    this.logger.info('leaderboard.scheduler_started', {
      cronExpression: GIVEAWAY_LEADERBOARD_CRON,
      nextScheduledAt: this.getNextLeaderboardScheduledAt(),
      timezone: GIVEAWAY_LEADERBOARD_TIMEZONE
    });
  }

  stopLeaderboardScheduler() {
    if (!this.leaderboardJob) {
      return;
    }

    this.leaderboardJob.stop();

    if (typeof this.leaderboardJob.destroy === 'function') {
      this.leaderboardJob.destroy();
    }

    this.leaderboardJob = null;
    this.isPostingLeaderboard = false;
    this.logger.info('leaderboard.scheduler_stopped', {
      cronExpression: GIVEAWAY_LEADERBOARD_CRON,
      nextScheduledAt: null,
      timezone: GIVEAWAY_LEADERBOARD_TIMEZONE
    });
  }

  attachLeaderboardJobListeners() {
    if (!this.leaderboardJob || typeof this.leaderboardJob.on !== 'function') {
      return;
    }

    this.leaderboardJob.on('execution:missed', (executionContext) => {
      this.logger.warn('leaderboard.scheduler_missed_execution', {
        ...buildLeaderboardRunLogContext(buildLeaderboardSchedulerRunContext(executionContext)),
        nextScheduledAt: this.getNextLeaderboardScheduledAt()
      });
    });

    this.leaderboardJob.on('execution:overlap', (executionContext) => {
      this.logger.warn('leaderboard.scheduler_overlap', {
        ...buildLeaderboardRunLogContext(buildLeaderboardSchedulerRunContext(executionContext)),
        nextScheduledAt: this.getNextLeaderboardScheduledAt()
      });
    });

    this.leaderboardJob.on('execution:failed', (executionContext) => {
      const error =
        executionContext?.execution?.error ||
        new Error('Giveaway leaderboard scheduler execution failed.');

      this.logger.error('leaderboard.scheduler_execution_failed', error, {
        ...buildLeaderboardRunLogContext(buildLeaderboardSchedulerRunContext(executionContext)),
        nextScheduledAt: this.getNextLeaderboardScheduledAt()
      });
    });
  }

  getNextLeaderboardScheduledAt() {
    if (!this.leaderboardJob || typeof this.leaderboardJob.getNextRun !== 'function') {
      return null;
    }

    return normalizeLogTimestamp(this.leaderboardJob.getNextRun());
  }

  async postDailyLeaderboard(runContext = {}) {
    const runLogContext = buildLeaderboardRunLogContext(runContext);

    if (this.isPostingLeaderboard) {
      this.logger.warn('leaderboard.scheduler_overlap', {
        ...runLogContext,
        nextScheduledAt: this.getNextLeaderboardScheduledAt()
      });
      return;
    }

    this.isPostingLeaderboard = true;

    try {
      const guilds = Array.from(this.discordClient.guilds?.cache?.values?.() || []);

      for (const guild of guilds) {
        try {
          await this.postLeaderboardForGuild(guild, runContext);
        } catch (error) {
          this.logger.error('leaderboard.post_failed', error, {
            ...runLogContext,
            failureStage: 'guild_iteration',
            guildId: guild?.id || null
          });
        }
      }
    } finally {
      this.isPostingLeaderboard = false;
    }
  }

  async postLeaderboardForGuild(guild, runContext = {}) {
    const postDateUtc = resolveLeaderboardPostDateUtc(runContext);
    const leaderboard = this.getLeaderboard(guild?.id, {
      limit: GIVEAWAY_LEADERBOARD_LIMIT
    });
    const logContext = {
      ...buildLeaderboardRunLogContext(runContext),
      channelId: null,
      entryCount: leaderboard.length,
      guildId: guild?.id || null,
      postDateUtc
    };

    if (!leaderboard.length) {
      this.logger.info('leaderboard.post_skipped_no_wins', logContext);
      return;
    }

    const channel = await this.resolveGiveawayLeaderboardChannel(guild, runContext, {
      postDateUtc
    });

    if (!channel) {
      return;
    }

    const entries = await this.resolveLeaderboardDisplayEntries(guild, leaderboard, {
      messageId: null
    });
    const startedAt = new Date().toISOString();
    const claimed = this.giveawayStore.tryBeginLeaderboardPost({
      guildId: guild.id,
      postDateUtc,
      channelId: channel.id,
      startedAt
    });

    if (!claimed) {
      return;
    }

    this.logger.info('leaderboard.post_started', {
      ...logContext,
      channelId: channel.id,
      entryCount: entries.length
    });

    try {
      const message = await channel.send({
        embeds: [
          buildGiveawayLeaderboardEmbed({
            guildName: guild?.name || null,
            entries
          })
        ]
      });

      this.giveawayStore.markLeaderboardPostCompleted({
        guildId: guild.id,
        postDateUtc,
        channelId: channel.id,
        messageId: message?.id || null,
        completedAt: new Date().toISOString()
      });

      this.logger.info('leaderboard.post_completed', {
        ...logContext,
        channelId: channel.id,
        entryCount: entries.length,
        messageId: message?.id || null
      });
    } catch (error) {
      this.giveawayStore.markLeaderboardPostFailed({
        guildId: guild.id,
        postDateUtc,
        channelId: channel.id,
        failureReason: error?.message || 'Failed to send giveaway leaderboard post.',
        failedAt: new Date().toISOString()
      });
      this.logger.error('leaderboard.post_failed', error, {
        ...logContext,
        channelId: channel.id,
        failureStage: 'send'
      });
    }
  }

  async resolveGiveawayLeaderboardChannel(guild, runContext = {}, {
    postDateUtc = resolveLeaderboardPostDateUtc(runContext)
  } = {}) {
    const logContext = {
      ...buildLeaderboardRunLogContext(runContext),
      guildId: guild?.id || null,
      postDateUtc
    };

    if (!guild?.channels) {
      this.logger.error(
        'leaderboard.post_failed',
        new Error('The guild channel cache is unavailable for the giveaway leaderboard post.'),
        {
          ...logContext,
          failureStage: 'resolve_channel',
          reason: 'guild_channels_unavailable'
        }
      );
      return null;
    }

    let channelCollection = guild.channels.cache || null;

    if ((!channelCollection || !channelCollection.size) && typeof guild.channels.fetch === 'function') {
      try {
        channelCollection = await guild.channels.fetch();
      } catch (error) {
        this.logger.error('leaderboard.post_failed', error, {
          ...logContext,
          failureStage: 'resolve_channel',
          reason: 'channel_fetch_failed'
        });
        return null;
      }
    }

    const candidates = Array.from(channelCollection?.values?.() || [])
      .filter(
        (channel) =>
          String(channel?.name || '').trim().toLowerCase() === GIVEAWAY_LEADERBOARD_CHANNEL_NAME &&
          channel?.guildId === guild.id &&
          channel?.isTextBased?.() === true &&
          typeof channel?.send === 'function'
      )
      .sort((left, right) => String(left?.id || '').localeCompare(String(right?.id || '')));
    const channel = candidates[0] || null;

    if (!channel) {
      this.logger.error(
        'leaderboard.post_failed',
        new Error('No sendable #giveaways channel is configured for this guild.'),
        {
          ...logContext,
          failureStage: 'resolve_channel',
          reason: 'channel_not_found'
        }
      );
      return null;
    }

    const permissions =
      typeof channel.permissionsFor === 'function' && this.discordClient.user?.id
        ? channel.permissionsFor(this.discordClient.user.id)
        : null;
    const missingPermissions = permissions
      ? REQUIRED_GIVEAWAY_LEADERBOARD_PERMISSIONS.filter(
          (permission) => !permissions.has(permission, true)
        )
      : REQUIRED_GIVEAWAY_LEADERBOARD_PERMISSIONS.slice();

    if (missingPermissions.length) {
      this.logger.error(
        'leaderboard.post_failed',
        new Error('The configured #giveaways channel is missing required permissions.'),
        {
          ...logContext,
          channelId: channel.id,
          failureStage: 'resolve_channel',
          missingPermissions: missingPermissions.map(formatPermissionName)
        }
      );
      return null;
    }

    return channel;
  }

  async resolveLeaderboardDisplayEntries(guild, leaderboardEntries, {
    messageId = null
  } = {}) {
    const resolvedEntries = [];
    const displayLabelCache = new Map();

    for (const entry of Array.isArray(leaderboardEntries) ? leaderboardEntries : []) {
      if (!entry) {
        continue;
      }

      resolvedEntries.push({
        ...entry,
        displayLabel: await this.resolveLeaderboardDisplayLabel(guild, entry, {
          messageId,
          displayLabelCache
        })
      });
    }

    return resolvedEntries;
  }

  async resolveLeaderboardDisplayLabel(guild, entry, {
    messageId = null,
    displayLabelCache = null
  } = {}) {
    const userId = String(entry?.userId || '').trim();

    if (!userId) {
      return 'Unknown User';
    }

    if (displayLabelCache instanceof Map && displayLabelCache.has(userId)) {
      return displayLabelCache.get(userId);
    }

    const member = await this.fetchGuildMember(guild, userId, {
      logMessage: 'leaderboard.member_fetch_failed',
      messageId
    });
    const displayLabel = member?.displayName ?? member?.user?.username ?? 'Unknown User';

    if (displayLabelCache instanceof Map) {
      displayLabelCache.set(userId, displayLabel);
    }

    return displayLabel;
  }

  async resolveWinnerIdentitySnapshots(guildId, messageId, winnerIds) {
    const normalizedWinnerIds = normalizeIdList(winnerIds);
    const guild = await this.fetchGuild(guildId);
    const snapshots = await Promise.all(
      normalizedWinnerIds.map((winnerId) =>
        this.resolveWinnerIdentitySnapshot(guild, guildId, messageId, winnerId)
      )
    );

    return snapshots.filter(Boolean);
  }

  async resolveWinnerIdentitySnapshot(guild, guildId, messageId, winnerId) {
    const storedLabel =
      (await this.resolveGuildMemberLabel(guild, winnerId, {
        logMessage: 'giveaway.winner_member_fetch_failed',
        guildId,
        messageId
      })) ||
      (await this.resolveGlobalUserLabel(winnerId, {
        logMessage: 'giveaway.winner_user_fetch_failed',
        guildId,
        messageId
      })) ||
      null;

    return {
      userId: String(winnerId),
      storedLabel
    };
  }

  async resolveGuildMemberLabel(guild, userId, {
    guildId = guild?.id || null,
    messageId = null,
    logMessage = 'giveaway.member_fetch_failed'
  } = {}) {
    const member = await this.fetchGuildMember(guild, userId, {
      guildId,
      messageId,
      logMessage
    });

    return buildPreferredMemberLabel(member);
  }

  async resolveGlobalUserLabel(userId, {
    guildId = null,
    messageId = null,
    logMessage = 'giveaway.user_fetch_failed'
  } = {}) {
    const user = await this.fetchGlobalUser(userId, {
      guildId,
      messageId,
      logMessage
    });

    return buildPreferredUserLabel(user);
  }

  async fetchGlobalUser(userId, {
    guildId = null,
    messageId = null,
    logMessage = 'giveaway.user_fetch_failed'
  } = {}) {
    if (!userId || !this.discordClient.users || typeof this.discordClient.users.fetch !== 'function') {
      return null;
    }

    try {
      return await this.discordClient.users.fetch(userId);
    } catch (error) {
      if (!isUnknownMemberError(error)) {
        this.logger.warn(logMessage, error, {
          guildId,
          messageId,
          userId
        });
      }

      return null;
    }
  }

  async fetchGuildMember(guild, userId, {
    guildId = guild?.id || null,
    messageId = null,
    logMessage = 'giveaway.member_fetch_failed'
  } = {}) {
    const normalizedUserId = String(userId || '').trim();

    if (!normalizedUserId) {
      return null;
    }

    const cachedMember = guild?.members?.cache?.get?.(normalizedUserId) || null;

    if (cachedMember) {
      return cachedMember;
    }

    if (!guild?.members || typeof guild.members.fetch !== 'function') {
      return null;
    }

    try {
      return await guild.members.fetch(normalizedUserId);
    } catch (error) {
      if (!isUnknownMemberError(error)) {
        this.logger.warn(logMessage, error, {
          guildId,
          messageId,
          userId: normalizedUserId
        });
      }

      return null;
    }
  }

  logRecordedLeaderboardWins(giveaway, leaderboardSync, {
    source = 'end'
  } = {}) {
    const addedWinnerIds = Array.isArray(leaderboardSync?.addedWinnerIds)
      ? leaderboardSync.addedWinnerIds
      : [];

    if (!giveaway?.guildId || !giveaway?.messageId || !addedWinnerIds.length) {
      return;
    }

    const leaderboardCounts = new Map(
      this.getLeaderboard(giveaway.guildId, {
        limit: 100
      }).map((entry) => [entry.userId, entry.winCount])
    );

    for (const userId of addedWinnerIds) {
      this.logger.info('leaderboard.win_recorded', {
        giveawayMessageId: giveaway.messageId,
        guildId: giveaway.guildId,
        source,
        totalWins: leaderboardCounts.has(userId) ? leaderboardCounts.get(userId) : null,
        userId
      });
    }
  }

  listActiveGiveawaysByGuild(guildId) {
    const normalizedGuildId = String(guildId || '').trim();

    if (!normalizedGuildId) {
      return [];
    }

    return this.giveawayStore
      .listPendingGiveaways()
      .filter((giveaway) => giveaway.guildId === normalizedGuildId)
      .sort(compareGiveawaysByEndAt);
  }

  async createGiveaway({
    channel,
    hostUser,
    prizeText,
    winnerCount,
    durationMs = 0,
    endMode = GIVEAWAY_END_MODE_TIME,
    gameType = 'standard',
    maxEntries = null,
    winnerCooldownEnabled = false,
    winnerCooldownMs = DEFAULT_GIVEAWAY_WINNER_COOLDOWN_MS
  }) {
    const normalizedEndMode = normalizeGiveawayEndMode(endMode);
    const normalizedGameType = normalizeGiveawayGameType(gameType);
    const normalizedMaxEntries =
      normalizedEndMode === GIVEAWAY_END_MODE_ENTRIES
        ? normalizeGiveawayMaxEntries(maxEntries)
        : null;
    const normalizedWinnerCooldownEnabled =
      normalizeGiveawayWinnerCooldownEnabled(winnerCooldownEnabled);
    const normalizedWinnerCooldownMs = normalizeGiveawayWinnerCooldownMs(
      winnerCooldownMs
    );
    const endAt =
      normalizedEndMode === GIVEAWAY_END_MODE_TIME
        ? new Date(Date.now() + durationMs).toISOString()
        : null;
    const giveawaysRole = channel.guild?.roles?.cache?.find(
      (role) => role.name === GIVEAWAYS_ROLE_NAME
    ) || null;
    let message = null;
    let createdGiveaway = null;

    try {
      message = await channel.send({
        content: giveawaysRole ? `<@&${giveawaysRole.id}>` : undefined,
        embeds: [
          buildGiveawayEmbed({
            prizeText,
            winnerCount,
            hostId: hostUser.id,
            endAt,
            status: 'active',
            endMode: normalizedEndMode,
            gameType: normalizedGameType,
            maxEntries: normalizedMaxEntries,
            winnerCooldownEnabled: normalizedWinnerCooldownEnabled,
            winnerCooldownMs: normalizedWinnerCooldownMs
          })
        ],
        allowedMentions: giveawaysRole
          ? {
              parse: [],
              roles: [giveawaysRole.id]
            }
          : undefined
      });

      createdGiveaway = this.giveawayStore.createGiveaway({
        guildId: channel.guildId,
        channelId: channel.id,
        messageId: message.id,
        hostId: hostUser.id,
        prizeText,
        winnerCount,
        durationMs,
        endAt,
        endMode: normalizedEndMode,
        gameType: normalizedGameType,
        maxEntries: normalizedMaxEntries,
        winnerCooldownEnabled: normalizedWinnerCooldownEnabled,
        winnerCooldownMs: normalizedWinnerCooldownMs
      });

      await message.react(GIVEAWAY_EMOJI);
      this.scheduleGiveaway(createdGiveaway);
      this.logger.info('giveaway.game_type', {
        gameType: createdGiveaway.gameType,
        guildId: createdGiveaway.guildId,
        messageId: createdGiveaway.messageId,
        phase: 'created'
      });
      this.logger.info('giveaway.created', {
        channelId: createdGiveaway.channelId,
        endMode: createdGiveaway.endMode,
        endAt: createdGiveaway.endAt,
        gameType: createdGiveaway.gameType,
        guildId: createdGiveaway.guildId,
        hostId: createdGiveaway.hostId,
        maxEntries: createdGiveaway.maxEntries,
        messageId: createdGiveaway.messageId,
        winnerCooldownEnabled: createdGiveaway.winnerCooldownEnabled,
        winnerCooldownMs: createdGiveaway.winnerCooldownMs,
        winnerCount: createdGiveaway.winnerCount
      });

      return {
        giveaway: createdGiveaway,
        message
      };
    } catch (error) {
      if (createdGiveaway?.messageId) {
        try {
          this.giveawayStore.deleteGiveaway(createdGiveaway.messageId);
        } catch (cleanupError) {
          this.logger.warn('giveaway.create_store_cleanup_failed', cleanupError, {
            messageId: createdGiveaway.messageId
          });
        }
      }

      if (message) {
        try {
          await message.delete();
        } catch (cleanupError) {
          this.logger.warn('giveaway.create_message_cleanup_failed', cleanupError, {
            channelId: channel.id,
            messageId: message.id
          });
        }
      }

      throw error;
    }
  }

  async endGiveawayByMessageId(messageId, {
    allowResumeEnding = false,
    initiatedBy = 'system',
    entrantIdsSnapshot = null
  } = {}) {
    const normalizedMessageId = normalizeGiveawayMessageId(messageId);
    let giveaway = this.giveawayStore.getGiveawayByMessageId(normalizedMessageId);

    if (!giveaway) {
      throw new Error('No giveaway was found for that message ID.');
    }

    if (Array.isArray(entrantIdsSnapshot) && entrantIdsSnapshot.length) {
      this.rememberEntryCloseSnapshot(normalizedMessageId, entrantIdsSnapshot);
    }

    if (giveaway.status === 'ended') {
      this.clearEntryCloseSnapshot(normalizedMessageId);
      return buildOutcome('already_ended', giveaway);
    }

    if (this.inFlightMessageIds.has(normalizedMessageId)) {
      return buildOutcome('already_processing', giveaway);
    }

    this.inFlightMessageIds.add(normalizedMessageId);

    try {
      if (giveaway.status === 'active') {
        const claimed = this.giveawayStore.transitionGiveawayStatus({
          messageId: normalizedMessageId,
          fromStatus: 'active',
          toStatus: 'ending'
        });

        if (!claimed) {
          giveaway = this.giveawayStore.getGiveawayByMessageId(normalizedMessageId) || giveaway;

          if (giveaway.status === 'ended') {
            this.clearEntryCloseSnapshot(normalizedMessageId);
            return buildOutcome('already_ended', giveaway);
          }

          return buildOutcome('already_processing', giveaway);
        }

        this.clearScheduledGiveaway(normalizedMessageId);
        giveaway = this.giveawayStore.getGiveawayByMessageId(normalizedMessageId) || {
          ...giveaway,
          status: 'ending'
        };
      } else if (giveaway.status === 'ending' && !allowResumeEnding) {
        return buildOutcome('already_processing', giveaway);
      } else if (giveaway.status === 'ending') {
        this.clearScheduledGiveaway(normalizedMessageId);
      }

      const result = await this.finalizeGiveaway(giveaway, {
        initiatedBy,
        entrantIdsSnapshot: this.getEntryCloseSnapshot(normalizedMessageId)
      });

      this.clearEntryCloseSnapshot(normalizedMessageId);

      this.logger.info('giveaway.ended', {
        announcementSent: result.announcementSent,
        entrantCount: result.entrantCount,
        gameType: result.giveaway.gameType,
        guildId: result.giveaway.guildId,
        initiatedBy,
        messageEdited: result.messageEdited,
        messageId: result.giveaway.messageId,
        winnerCount: result.winnerIds.length
      });

      return result;
    } catch (error) {
      const currentGiveaway = this.giveawayStore.getGiveawayByMessageId(normalizedMessageId);

      if (currentGiveaway?.status === 'ending') {
        if (isUnrecoverableDiscordError(error)) {
          const {
            giveaway: endedGiveaway,
            leaderboardSync
          } = this.giveawayStore.markGiveawayEnded({
            messageId: normalizedMessageId,
            entrantIds: currentGiveaway.entrantIds,
            winnerIds: [],
            endedAt: new Date().toISOString()
          });
          this.logRecordedLeaderboardWins(endedGiveaway, leaderboardSync, {
            source: 'forced_end'
          });
          this.clearEntryCloseSnapshot(normalizedMessageId);

          this.logger.warn('giveaway.end_forced_without_message_access', error, {
            channelId: currentGiveaway.channelId,
            guildId: currentGiveaway.guildId,
            initiatedBy,
            messageId: currentGiveaway.messageId
          });

          return {
            ...buildOutcome('ended_without_access', endedGiveaway),
            announcementSent: false,
            messageEdited: false
          };
        }

        this.giveawayStore.transitionGiveawayStatus({
          messageId: normalizedMessageId,
          fromStatus: 'ending',
          toStatus: 'active'
        });

        const recoveredGiveaway = this.giveawayStore.getGiveawayByMessageId(normalizedMessageId);

        if (initiatedBy === 'system') {
          this.scheduleRetry(normalizedMessageId);
        } else if (recoveredGiveaway?.status === 'active') {
          this.scheduleGiveaway(recoveredGiveaway);
        }
      }

      throw error;
    } finally {
      this.inFlightMessageIds.delete(normalizedMessageId);
    }
  }

  async rerollGiveawayByMessageId(messageId, {
    rerolledBy = null
  } = {}) {
    const normalizedMessageId = normalizeGiveawayMessageId(messageId);
    const giveaway = this.giveawayStore.getGiveawayByMessageId(normalizedMessageId);

    if (!giveaway) {
      throw new Error('No giveaway was found for that message ID.');
    }

    if (giveaway.status !== 'ended') {
      throw new Error('That giveaway has not ended yet, so it cannot be rerolled.');
    }

    if (!giveaway.entrantIds.length) {
      return {
        ...buildOutcome('no_entrants', giveaway),
        announcementSent: false,
        messageEdited: false
      };
    }

    const eligibleEntrantIds = await this.resolveEligibleEntrantIds(
      giveaway.guildId,
      giveaway.entrantIds,
      {
        messageId: normalizedMessageId
      }
    );
    const gameResult = this.resolveGameResult(giveaway, eligibleEntrantIds, {
      phase: 'reroll',
      rerolled: true
    });
    const rerolledAt = new Date().toISOString();
    const winnerSnapshots = await this.resolveWinnerIdentitySnapshots(
      giveaway.guildId,
      normalizedMessageId,
      gameResult.winnerIds
    );
    const {
      giveaway: updatedGiveaway,
      leaderboardSync
    } = this.giveawayStore.updateGiveawayWinners({
      messageId: normalizedMessageId,
      winnerIds: gameResult.winnerIds,
      winnerSnapshots,
      rerolledAt,
      rerolledBy
    });
    this.logRecordedLeaderboardWins(updatedGiveaway, leaderboardSync, {
      source: 'reroll'
    });
    this.startWinnerCooldowns(updatedGiveaway, {
      startedAt: rerolledAt
    });

    let messageEdited = false;
    let announcementSent = false;

    try {
      const { channel, message } = await this.fetchGiveawayMessage(updatedGiveaway);
      await this.safeRevealRussianRouletteOnGiveawayMessage(message, updatedGiveaway, {
        gameResult
      });
      messageEdited = await this.safeEditGiveawayMessage(message, updatedGiveaway, {
        eligibleEntrantCount: eligibleEntrantIds.length,
        gameResult
      });
      announcementSent = await this.safeSendAnnouncement(channel, updatedGiveaway, {
        rerolled: true,
        eligibleEntrantCount: eligibleEntrantIds.length,
        gameResult
      });
    } catch (error) {
      this.logger.warn('giveaway.reroll_message_update_failed', error, {
        channelId: updatedGiveaway.channelId,
        guildId: updatedGiveaway.guildId,
        messageId: updatedGiveaway.messageId
      });
    }

    this.logger.info('giveaway.rerolled', {
      announcementSent,
      entrantCount: eligibleEntrantIds.length,
      guildId: updatedGiveaway.guildId,
      gameType: updatedGiveaway.gameType,
      messageEdited,
      messageId: updatedGiveaway.messageId,
      winnerCount: updatedGiveaway.winnerIds.length
    });

    return {
      ...buildOutcome('rerolled', updatedGiveaway, {
        entrantCount: eligibleEntrantIds.length
      }),
      announcementSent,
      messageEdited,
      gameResult
    };
  }

  async handleReactionAdd(reaction, user) {
    const resolvedUser = await this.hydrateUser(user);

    if (!reaction || !resolvedUser || resolvedUser.bot) {
      return;
    }

    const resolvedReaction = await this.hydrateReaction(reaction);

    if (!resolvedReaction?.message?.id) {
      return;
    }

    const giveaway = this.giveawayStore.getGiveawayByMessageId(resolvedReaction.message.id);

    if (!giveaway) {
      return;
    }

    const isTrackedEntryReaction =
      normalizeEmojiName(resolvedReaction.emoji?.name) === normalizeEmojiName(GIVEAWAY_EMOJI);

    if (!isGiveawayExpired(giveaway) && !isTrackedEntryReaction) {
      return;
    }

    if (isGiveawayExpired(giveaway)) {
      await this.safeRemoveReactionUser(resolvedReaction, resolvedUser.id, giveaway);

      if (giveaway.status === 'active') {
        void this.endGiveawayByMessageId(giveaway.messageId, {
          initiatedBy: 'system'
        }).catch((error) => {
          this.logger.warn('giveaway.expired_reaction_end_failed', error, {
            guildId: giveaway.guildId,
            messageId: giveaway.messageId
          });
        });
      }

      await this.safeNotifyExpiredReactionUser(
        resolvedReaction.message.channel,
        resolvedReaction.message.guild,
        resolvedUser,
        giveaway
      );
      return;
    }

    if (!isTrackedEntryReaction) {
      return;
    }

    await this.handleActiveGiveawayReaction(resolvedReaction, resolvedUser, giveaway);
  }

  async handleActiveGiveawayReaction(reaction, user, giveaway) {
    let currentGiveaway = giveaway;

    if (currentGiveaway.winnerCooldownEnabled) {
      const activeCooldown = this.giveawayStore.getWinnerCooldownByUserId(user.id);

      if (activeCooldown) {
        currentGiveaway = this.blockGiveawayEntry(currentGiveaway, user.id);
        await this.safeRemoveReactionUser(reaction, user.id, currentGiveaway, {
          failureLogMessage: 'giveaway.entry_cooldown_reaction_remove_failed'
        });
        this.logger.info('giveaway.entry_rejected_cooldown', {
          cooldownEndsAt: activeCooldown.cooldownEndsAt,
          endMode: currentGiveaway.endMode,
          guildId: currentGiveaway.guildId,
          maxEntries: currentGiveaway.maxEntries,
          messageId: currentGiveaway.messageId,
          userId: user.id,
          winnerCooldownMs: currentGiveaway.winnerCooldownMs
        });
        await this.safeNotifyEntryCooldownUser(
          reaction.message.channel,
          reaction.message.guild,
          user,
          currentGiveaway,
          activeCooldown
        );
        return;
      }
    }

    currentGiveaway = this.unblockGiveawayEntry(currentGiveaway, user.id);

    if (normalizeGiveawayEndMode(currentGiveaway.endMode) !== GIVEAWAY_END_MODE_ENTRIES) {
      return;
    }

    await this.maybeCloseGiveawayByEntries(reaction, currentGiveaway, {
      triggeringUserId: user.id
    });
  }

  async handleHostPrizeConfirmationMessage(message) {
    if (
      !message?.guildId ||
      !message?.channelId ||
      !message?.author?.id ||
      message.author.bot
    ) {
      return;
    }

    const content = String(message.content || '').trim();
    const prizeConfirmation = parsePrizeConfirmationMessage(content);

    if (!content || !prizeConfirmation) {
      return;
    }

    const announcementContext = this.findRecentGiveawayAnnouncement(message, prizeConfirmation);

    if (!announcementContext) {
      return;
    }

    const winnerId = resolveConfirmedWinnerId(message, announcementContext, prizeConfirmation);

    if (!winnerId) {
      return;
    }

    const followUpSent = await this.safeSendPrizeDeliveryFollowUp(message, winnerId, announcementContext);

    if (followUpSent) {
      announcementContext.followUpSent = true;
      announcementContext.followUpSentAt = Date.now();
    }
  }

  scheduleGiveaway(giveaway) {
    if (!giveaway?.messageId) {
      return;
    }

    this.clearScheduledGiveaway(giveaway.messageId);

    if (
      giveaway.status !== 'ending' &&
      normalizeGiveawayEndMode(giveaway.endMode) !== GIVEAWAY_END_MODE_TIME
    ) {
      return;
    }

    const endAtMs = Date.parse(giveaway.endAt || '');
    const delayMs =
      giveaway.status === 'ending' || !Number.isFinite(endAtMs)
        ? 0
        : Math.max(0, endAtMs - Date.now());
    const timerDelayMs = Math.min(delayMs, MAX_GIVEAWAY_TIMER_DELAY_MS);
    const timer = setTimeout(() => {
      const currentGiveaway = this.giveawayStore.getGiveawayByMessageId(giveaway.messageId);

      if (
        currentGiveaway?.status === 'active' &&
        normalizeGiveawayEndMode(currentGiveaway.endMode) === GIVEAWAY_END_MODE_TIME &&
        !isGiveawayExpired(currentGiveaway)
      ) {
        this.scheduleGiveaway(currentGiveaway);
        return;
      }

      void this.endGiveawayByMessageId(giveaway.messageId, {
        allowResumeEnding: giveaway.status === 'ending',
        initiatedBy: 'system'
      }).catch((error) => {
        this.logger.error('giveaway.scheduled_end_failed', error, {
          channelId: giveaway.channelId,
          guildId: giveaway.guildId,
          messageId: giveaway.messageId
        });
      });
    }, timerDelayMs);

    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    this.timers.set(giveaway.messageId, timer);
  }

  async recoverEntryModeGiveaway(giveaway) {
    if (
      !giveaway?.messageId ||
      giveaway.status !== 'active' ||
      normalizeGiveawayEndMode(giveaway.endMode) !== GIVEAWAY_END_MODE_ENTRIES ||
      !Number.isFinite(giveaway.maxEntries)
    ) {
      return;
    }

    try {
      const { message } = await this.fetchGiveawayMessage(giveaway);
      const entrantIdsSnapshot = await this.collectAcceptedEntryIdsFromMessage(
        message,
        giveaway
      );

      if (entrantIdsSnapshot.length < giveaway.maxEntries) {
        return;
      }

      await this.maybeCloseGiveawayByEntries(null, giveaway, {
        entrantIdsSnapshot,
        recoveredOnStartup: true
      });
    } catch (error) {
      this.logger.warn('giveaway.entries_recovery_failed', error, {
        guildId: giveaway.guildId,
        maxEntries: giveaway.maxEntries,
        messageId: giveaway.messageId
      });
    }
  }

  scheduleRetry(messageId, delayMs = 60_000) {
    const giveaway = this.giveawayStore.getGiveawayByMessageId(messageId);

    if (!giveaway || giveaway.status !== 'active') {
      return;
    }

    this.clearScheduledGiveaway(messageId);

    const timer = setTimeout(() => {
      void this.endGiveawayByMessageId(messageId, {
        initiatedBy: 'system'
      }).catch((error) => {
        this.logger.error('giveaway.retry_end_failed', error, {
          messageId
        });
      });
    }, Math.max(1_000, Math.floor(Number(delayMs) || 60_000)));

    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    this.timers.set(messageId, timer);
  }

  clearScheduledGiveaway(messageId) {
    const timer = this.timers.get(messageId);

    if (!timer) {
      return;
    }

    clearTimeout(timer);
    this.timers.delete(messageId);
  }

  async finalizeGiveaway(giveaway, {
    entrantIdsSnapshot = null
  } = {}) {
    const { channel, message } = await this.fetchGiveawayMessage(giveaway);
    const entrantIds = Array.isArray(entrantIdsSnapshot)
      ? await this.resolveEligibleEntrantIds(giveaway.guildId, entrantIdsSnapshot, {
          messageId: giveaway.messageId
        })
      : await this.collectEntrantIds(message, giveaway);
    const gameResult = this.resolveGameResult(giveaway, entrantIds, {
      phase: 'end'
    });
    await this.safeRevealRussianRouletteOnGiveawayMessage(message, giveaway, {
      gameResult
    });
    const endedAt = new Date().toISOString();
    const winnerSnapshots = await this.resolveWinnerIdentitySnapshots(
      giveaway.guildId,
      giveaway.messageId,
      gameResult.winnerIds
    );
    const {
      giveaway: endedGiveaway,
      leaderboardSync
    } = this.giveawayStore.markGiveawayEnded({
      messageId: giveaway.messageId,
      entrantIds,
      winnerIds: gameResult.winnerIds,
      winnerSnapshots,
      endedAt
    });
    this.logRecordedLeaderboardWins(endedGiveaway, leaderboardSync, {
      source: 'end'
    });
    this.startWinnerCooldowns(endedGiveaway, {
      startedAt: endedAt
    });
    const messageEdited = await this.safeEditGiveawayMessage(message, endedGiveaway, {
      eligibleEntrantCount: entrantIds.length,
      gameResult
    });
    const announcementSent = await this.safeSendAnnouncement(channel, endedGiveaway, {
      rerolled: false,
      eligibleEntrantCount: entrantIds.length,
      gameResult
    });

    return {
      ...buildOutcome('ended', endedGiveaway, {
        entrantCount: entrantIds.length
      }),
      announcementSent,
      messageEdited,
      gameResult
    };
  }

  async fetchGiveawayMessage(giveaway) {
    const channel = await this.discordClient.channels.fetch(giveaway.channelId);

    if (!channel || !channel.isTextBased() || !channel.messages || typeof channel.messages.fetch !== 'function') {
      const error = new Error('The giveaway channel is no longer available.');
      error.code = 10003;
      throw error;
    }

    const message = await channel.messages.fetch(giveaway.messageId);

    if (!message) {
      const error = new Error('The giveaway message is no longer available.');
      error.code = 10008;
      throw error;
    }

    return {
      channel,
      message
    };
  }

  async collectEntrantIds(message, giveaway) {
    const entrantIds = await this.collectAcceptedEntryIdsFromMessage(message, giveaway);

    return this.resolveEligibleEntrantIds(giveaway.guildId, entrantIds, {
      messageId: giveaway.messageId
    });
  }

  async collectAcceptedEntryIdsFromMessage(message, giveaway) {
    const reaction = await this.getGiveawayReaction(message);

    if (!reaction) {
      return [];
    }

    return this.collectAcceptedEntryIdsFromReaction(reaction, giveaway);
  }

  async collectAcceptedEntryIdsFromReaction(reaction, giveaway) {
    if (!reaction?.users || typeof reaction.users.fetch !== 'function') {
      return [];
    }

    const users = await reaction.users.fetch();
    const blockedEntryIdSet = new Set(
      Array.isArray(giveaway?.blockedEntryIds) ? giveaway.blockedEntryIds : []
    );

    return Array.from(
      new Set(
        toArray(users)
          .map((entry) => entry?.id || null)
          .filter(
            (userId) =>
              userId &&
              userId !== this.discordClient.user?.id &&
              !blockedEntryIdSet.has(userId)
          )
      )
    );
  }

  async maybeCloseGiveawayByEntries(reaction, giveaway, {
    triggeringUserId = null,
    entrantIdsSnapshot = null,
    recoveredOnStartup = false
  } = {}) {
    if (
      !giveaway?.messageId ||
      giveaway.status !== 'active' ||
      normalizeGiveawayEndMode(giveaway.endMode) !== GIVEAWAY_END_MODE_ENTRIES ||
      !Number.isFinite(giveaway.maxEntries)
    ) {
      return;
    }

    const acceptedEntrantIds = Array.isArray(entrantIdsSnapshot)
      ? normalizeIdList(entrantIdsSnapshot)
      : await this.collectAcceptedEntryIdsFromReaction(reaction, giveaway);

    if (acceptedEntrantIds.length < giveaway.maxEntries) {
      return;
    }

    const storedNewSnapshot = this.rememberEntryCloseSnapshot(
      giveaway.messageId,
      acceptedEntrantIds
    );

    if (storedNewSnapshot) {
      this.logger.info('giveaway.closed_by_entries', {
        entrantCount: acceptedEntrantIds.length,
        endMode: giveaway.endMode,
        guildId: giveaway.guildId,
        maxEntries: giveaway.maxEntries,
        messageId: giveaway.messageId,
        recoveredOnStartup,
        triggeringUserId
      });
    }

    if (this.inFlightMessageIds.has(giveaway.messageId)) {
      return;
    }

    await this.endGiveawayByMessageId(giveaway.messageId, {
      initiatedBy: 'system',
      entrantIdsSnapshot: storedNewSnapshot
        ? acceptedEntrantIds
        : this.getEntryCloseSnapshot(giveaway.messageId)
    });
  }

  blockGiveawayEntry(giveaway, userId) {
    return this.syncBlockedGiveawayEntry(giveaway, userId, true);
  }

  unblockGiveawayEntry(giveaway, userId) {
    return this.syncBlockedGiveawayEntry(giveaway, userId, false);
  }

  syncBlockedGiveawayEntry(giveaway, userId, blocked) {
    if (!giveaway?.messageId || !userId) {
      return giveaway;
    }

    const currentBlockedIds = normalizeIdList(giveaway.blockedEntryIds);
    const nextBlockedIds = blocked
      ? normalizeIdList(currentBlockedIds.concat(String(userId)))
      : currentBlockedIds.filter((entryId) => entryId !== String(userId));

    if (currentBlockedIds.length === nextBlockedIds.length) {
      return giveaway;
    }

    return this.giveawayStore.updateGiveawayBlockedEntries({
      messageId: giveaway.messageId,
      blockedEntryIds: nextBlockedIds
    }) || {
      ...giveaway,
      blockedEntryIds: nextBlockedIds
    };
  }

  rememberEntryCloseSnapshot(messageId, entrantIds) {
    const normalizedMessageId = normalizeGiveawayMessageId(messageId);

    if (this.entryCloseSnapshots.has(normalizedMessageId)) {
      return false;
    }

    this.entryCloseSnapshots.set(normalizedMessageId, normalizeIdList(entrantIds));
    return true;
  }

  getEntryCloseSnapshot(messageId) {
    return this.entryCloseSnapshots.get(normalizeGiveawayMessageId(messageId)) || null;
  }

  clearEntryCloseSnapshot(messageId) {
    this.entryCloseSnapshots.delete(normalizeGiveawayMessageId(messageId));
  }

  async resolveEligibleEntrantIds(guildId, entrantIds, {
    messageId = null
  } = {}) {
    const botUserId = this.discordClient.user?.id || null;
    const uniqueEntrantIds = Array.from(
      new Set(
        Array.isArray(entrantIds)
          ? entrantIds
              .map((entrantId) => String(entrantId || '').trim())
              .filter((entrantId) => entrantId && entrantId !== botUserId)
          : []
      )
    );

    if (!uniqueEntrantIds.length) {
      return [];
    }

    const guild = await this.fetchGuild(guildId);

    if (!guild?.members || typeof guild.members.fetch !== 'function') {
      return [];
    }

    const resolvedEntrants = await Promise.all(
      uniqueEntrantIds.map((entrantId) =>
        this.resolveEligibleEntrantId(guild, entrantId, {
          guildId,
          messageId
        })
      )
    );

    return resolvedEntrants.filter(Boolean);
  }

  async resolveEligibleEntrantId(guild, entrantId, {
    guildId,
    messageId
  }) {
    try {
      const member = await guild.members.fetch(entrantId);

      if (!member || member.user?.bot) {
        return null;
      }

      return member.id;
    } catch (error) {
      if (!isUnknownMemberError(error)) {
        this.logger.warn('giveaway.entrant_member_fetch_failed', error, {
          guildId,
          messageId,
          userId: entrantId
        });
      }

      return null;
    }
  }

  async fetchGuild(guildId) {
    const normalizedGuildId = String(guildId || '').trim();

    if (!normalizedGuildId) {
      return null;
    }

    const cachedGuild = this.discordClient.guilds.cache.get(normalizedGuildId);

    if (cachedGuild) {
      return cachedGuild;
    }

    try {
      return await this.discordClient.guilds.fetch(normalizedGuildId);
    } catch (error) {
      this.logger.warn('giveaway.guild_fetch_failed', error, {
        guildId: normalizedGuildId
      });
      return null;
    }
  }

  async getGiveawayReaction(message) {
    const cachedReaction = message.reactions.cache.find(
      (reaction) => normalizeEmojiName(reaction.emoji.name) === normalizeEmojiName(GIVEAWAY_EMOJI)
    );

    if (cachedReaction) {
      return cachedReaction;
    }

    try {
      await message.fetch();
    } catch (error) {
      return null;
    }

    return (
      message.reactions.cache.find(
        (reaction) => normalizeEmojiName(reaction.emoji.name) === normalizeEmojiName(GIVEAWAY_EMOJI)
      ) || null
    );
  }

  async safeEditGiveawayMessage(message, giveaway, {
    eligibleEntrantCount = null,
    gameResult = null
  } = {}) {
    try {
      await message.edit({
        embeds: [
          buildGiveawayEmbed({
            prizeText: giveaway.prizeText,
            winnerCount: giveaway.winnerCount,
            hostId: giveaway.hostId,
            endAt: giveaway.endAt,
            status: giveaway.status,
            endMode: giveaway.endMode,
            gameType: giveaway.gameType,
            maxEntries: giveaway.maxEntries,
            winnerIds: giveaway.winnerIds,
            entrantCount: giveaway.entrantIds.length,
            eligibleEntrantCount,
            endedAt: giveaway.endedAt,
            rerolledAt: giveaway.rerolledAt,
            gameSummaryLine: gameResult?.summaryLine || null,
            winnerCooldownEnabled: giveaway.winnerCooldownEnabled,
            winnerCooldownMs: giveaway.winnerCooldownMs
          })
        ]
      });

      return true;
    } catch (error) {
      this.logger.warn('giveaway.message_edit_failed', error, {
        channelId: giveaway.channelId,
        guildId: giveaway.guildId,
        messageId: giveaway.messageId
      });
      return false;
    }
  }

  async safeRevealRussianRouletteOnGiveawayMessage(message, giveaway, {
    gameResult = null
  } = {}) {
    if (
      !shouldUseProgressiveRussianRouletteReveal(giveaway, gameResult) ||
      typeof message?.edit !== 'function'
    ) {
      return false;
    }

    const revealState = splitRussianRouletteDetailLines(gameResult?.detailLines);
    const baseContent = stripRussianRouletteRevealFromMessageContent(message.content);
    let visibleDetailLines = revealState.introLines.slice();

    try {
      if (!revealState.revealLines.length) {
        if (!visibleDetailLines.length) {
          return false;
        }

        await message.edit({
          content: buildRussianRouletteRevealMessageContent({
            baseContent,
            detailLines: visibleDetailLines
          }),
          allowedMentions: {
            parse: []
          }
        });

        return true;
      }

      for (let index = 0; index < revealState.revealLines.length; index += 1) {
        visibleDetailLines = visibleDetailLines.concat(revealState.revealLines[index]);

        await message.edit({
          content: buildRussianRouletteRevealMessageContent({
            baseContent,
            detailLines: visibleDetailLines
          }),
          allowedMentions: {
            parse: []
          }
        });

        if (index < revealState.revealLines.length - 1) {
          await this.delayFn(this.russianRouletteRevealDelayMs);
        }
      }

      return true;
    } catch (error) {
      this.logger.warn('giveaway.russian_roulette_reveal_failed', error, {
        channelId: giveaway?.channelId || null,
        guildId: giveaway?.guildId || null,
        messageId: giveaway?.messageId || null
      });
      return false;
    }
  }

  async safeSendAnnouncement(channel, giveaway, {
    rerolled = false,
    eligibleEntrantCount = null,
    gameResult = null
  } = {}) {
    let winnerReferences = [];
    let winnerProfiles = [];

    try {
      winnerReferences = await this.resolveWinnerAnnouncementReferences(giveaway);
      winnerProfiles = winnerReferences
        .filter((reference) => reference?.winnerId && reference?.profileUrl)
        .map((reference) => ({
          winnerId: String(reference.winnerId),
          profileUrl: reference.profileUrl,
          tornId: reference.tornId || null
        }));
    } catch (error) {
      this.logger.warn('giveaway.winner_reference_resolution_failed', error, {
        guildId: giveaway.guildId,
        messageId: giveaway.messageId
      });
    }

    const content = buildGiveawayAnnouncementContent({
      prizeText: giveaway.prizeText,
      gameType: giveaway.gameType,
      gameResult,
      winnerIds: giveaway.winnerIds,
      winnerProfiles,
      entrantCount: giveaway.entrantIds.length,
      eligibleEntrantCount,
      winnerCount: giveaway.winnerCount,
      rerolled
    });
    const allowedMentions = buildAnnouncementAllowedMentions(giveaway.winnerIds);

    try {
      const announcementMessage = await channel.send({
        content,
        allowedMentions
      });
      this.recordRecentGiveawayAnnouncement(giveaway, {
        announcementMessageId: announcementMessage?.id || null,
        winnerReferences
      });

      return true;
    } catch (error) {
      this.logger.warn('giveaway.announcement_failed', error, {
        channelId: giveaway.channelId,
        guildId: giveaway.guildId,
        messageId: giveaway.messageId,
        rerolled
      });
      return false;
    }
  }

  startWinnerCooldowns(giveaway, {
    startedAt = new Date().toISOString()
  } = {}) {
    if (
      !giveaway?.messageId ||
      !giveaway.winnerCooldownEnabled ||
      !Array.isArray(giveaway.winnerIds) ||
      !giveaway.winnerIds.length
    ) {
      return;
    }

    const cooldownMs = normalizeGiveawayWinnerCooldownMs(giveaway.winnerCooldownMs);
    const cooldownEndsAt = new Date(Date.parse(startedAt) + cooldownMs).toISOString();

    for (const winnerId of giveaway.winnerIds) {
      const winnerCooldown = this.giveawayStore.startWinnerCooldown({
        userId: winnerId,
        giveawayMessageId: giveaway.messageId,
        guildId: giveaway.guildId,
        cooldownEndsAt,
        startedAt
      });

      this.logger.info('giveaway.winner_cooldown_started', {
        cooldownEndsAt: winnerCooldown?.cooldownEndsAt || cooldownEndsAt,
        giveawayMessageId: giveaway.messageId,
        guildId: giveaway.guildId,
        userId: winnerId,
        winnerCooldownMs: cooldownMs
      });
    }
  }

  resolveGameResult(giveaway, entrantIds, {
    phase = 'end',
    rerolled = false
  } = {}) {
    const normalizedEntrantIds = normalizeIdList(entrantIds);

    this.logger.info('giveaway.game_type', {
      entrantCount: normalizedEntrantIds.length,
      gameType: giveaway.gameType,
      guildId: giveaway.guildId,
      messageId: giveaway.messageId,
      phase
    });
    this.logger.info('giveaway.game_started', {
      entrantCount: normalizedEntrantIds.length,
      gameType: giveaway.gameType,
      guildId: giveaway.guildId,
      messageId: giveaway.messageId,
      rerolled
    });

    const gameResult = resolveGiveawayGame({
      gameType: giveaway.gameType,
      entrantIds: normalizedEntrantIds,
      winnerCount: giveaway.winnerCount
    });

    this.logger.info('giveaway.game_completed', {
      entrantCount: normalizedEntrantIds.length,
      gameType: gameResult.gameType,
      guildId: giveaway.guildId,
      messageId: giveaway.messageId,
      participantCount: gameResult.participantIds.length,
      rerolled,
      winnerCount: gameResult.winnerIds.length,
      winnerIds: gameResult.winnerIds
    });
    this.logger.info('giveaway.winner_selection_result', {
      entrantCount: normalizedEntrantIds.length,
      gameType: gameResult.gameType,
      guildId: giveaway.guildId,
      messageId: giveaway.messageId,
      participantCount: gameResult.participantIds.length,
      participantIds: gameResult.participantIds.slice(0, 10),
      participantIdsTruncated: gameResult.participantIds.length > 10,
      summaryLine: gameResult.summaryLine,
      winnerIds: gameResult.winnerIds
    });

    return gameResult;
  }

  async resolveWinnerAnnouncementReferences(giveaway) {
    const winnerIds = Array.isArray(giveaway?.winnerIds) ? giveaway.winnerIds : [];

    if (!winnerIds.length) {
      return [];
    }

    const guild = await this.fetchGuild(giveaway.guildId);

    if (!guild?.members || typeof guild.members.fetch !== 'function') {
      return [];
    }

    const references = await Promise.all(
      winnerIds.map((winnerId) =>
        this.resolveWinnerAnnouncementReference(guild, winnerId, {
          guildId: giveaway.guildId,
          messageId: giveaway.messageId
        })
      )
    );

    return references.filter(Boolean);
  }

  async resolveWinnerAnnouncementReference(guild, winnerId, {
    guildId,
    messageId
  } = {}) {
    const member = await this.fetchGuildMember(guild, winnerId, {
      guildId,
      messageId,
      logMessage: 'giveaway.winner_member_fetch_failed'
    });
    const user = member?.user
      ? member.user
      : await this.fetchGlobalUser(winnerId, {
          guildId,
          messageId,
          logMessage: 'giveaway.winner_user_fetch_failed'
        });
    const aliases = collectWinnerReferenceAliases([
      member?.displayName,
      member?.nickname,
      member?.user?.globalName,
      member?.user?.username,
      member?.user?.tag,
      user?.globalName,
      user?.username,
      user?.tag
    ]);
    const tornId = extractTornIdFromMember(member) || extractTornIdFromUser(user);

    return {
      aliases,
      profileUrl: tornId ? buildTornProfileUrl(tornId) : null,
      tornId,
      winnerId: String(winnerId)
    };
  }

  recordRecentGiveawayAnnouncement(giveaway, {
    announcementMessageId = null,
    winnerReferences = []
  } = {}) {
    if (!giveaway?.messageId) {
      return;
    }

    this.pruneRecentGiveawayAnnouncements();
    this.recentGiveawayAnnouncements.set(giveaway.messageId, {
      announcementMessageId: announcementMessageId ? String(announcementMessageId) : null,
      channelId: giveaway.channelId,
      followUpSent: false,
      giveawayMessageId: giveaway.messageId,
      guildId: giveaway.guildId,
      hostId: giveaway.hostId,
      prizeText: giveaway.prizeText,
      recordedAt: Date.now(),
      winnerReferences: normalizeWinnerReferences(winnerReferences),
      winnerIds: Array.isArray(giveaway.winnerIds) ? giveaway.winnerIds.slice() : []
    });
    this.trimRecentGiveawayAnnouncements();
  }

  findRecentGiveawayAnnouncement(message, prizeConfirmation = null) {
    this.pruneRecentGiveawayAnnouncements();

    const recentAnnouncements = Array.from(this.recentGiveawayAnnouncements.values()).filter(
      (announcement) =>
        announcement.guildId === message.guildId &&
        announcement.channelId === message.channelId &&
        announcement.hostId === message.author.id &&
        announcement.followUpSent !== true &&
        Array.isArray(announcement.winnerIds) &&
        announcement.winnerIds.length > 0
    );

    if (!recentAnnouncements.length) {
      return null;
    }

    const referencedMessageId = String(message.reference?.messageId || '').trim() || null;

    if (referencedMessageId) {
      const referencedAnnouncements = recentAnnouncements.filter(
        (announcement) =>
          announcement.announcementMessageId === referencedMessageId ||
          announcement.giveawayMessageId === referencedMessageId
      );

      if (referencedAnnouncements.length === 1) {
        return referencedAnnouncements[0];
      }

      if (referencedAnnouncements.length > 1) {
        return null;
      }
    }

    const mentionedWinnerIds = getMentionedUserIds(message).filter((winnerId) =>
      recentAnnouncements.some((announcement) => announcement.winnerIds.includes(winnerId))
    );

    if (mentionedWinnerIds.length === 1) {
      const matchingAnnouncements = recentAnnouncements.filter((announcement) =>
        announcement.winnerIds.includes(mentionedWinnerIds[0])
      );

      return matchingAnnouncements.length === 1 ? matchingAnnouncements[0] : null;
    }

    if (prizeConfirmation) {
      const matchingAnnouncements = recentAnnouncements.filter((announcement) =>
        announcementMatchesPrizeConfirmation(announcement, prizeConfirmation)
      );

      if (matchingAnnouncements.length === 1) {
        return matchingAnnouncements[0];
      }

      if (matchingAnnouncements.length > 1) {
        return null;
      }

      if (hasPrizeConfirmationRecipient(prizeConfirmation)) {
        return null;
      }
    }

    return recentAnnouncements.length === 1 ? recentAnnouncements[0] : null;
  }

  pruneRecentGiveawayAnnouncements(now = Date.now()) {
    for (const [messageId, announcement] of this.recentGiveawayAnnouncements.entries()) {
      if ((announcement.recordedAt || 0) + RECENT_GIVEAWAY_ANNOUNCEMENT_WINDOW_MS <= now) {
        this.recentGiveawayAnnouncements.delete(messageId);
      }
    }
  }

  trimRecentGiveawayAnnouncements() {
    if (this.recentGiveawayAnnouncements.size <= MAX_RECENT_GIVEAWAY_ANNOUNCEMENTS) {
      return;
    }

    const oldestAnnouncement = Array.from(this.recentGiveawayAnnouncements.entries()).sort(
      (left, right) => (left[1]?.recordedAt || 0) - (right[1]?.recordedAt || 0)
    )[0];

    if (oldestAnnouncement) {
      this.recentGiveawayAnnouncements.delete(oldestAnnouncement[0]);
    }
  }

  async safeSendPrizeDeliveryFollowUp(message, winnerId, announcementContext) {
    const payload = {
      content:
        `Congrats <@${winnerId}>, your prize should be with you now. ` +
        `When you have a moment, please share your win on the DroqsDB forum: ${this.prizeDeliveryForumUrl}`,
      allowedMentions: {
        parse: [],
        repliedUser: false,
        users: [winnerId]
      }
    };

    try {
      if (typeof message.reply === 'function') {
        await message.reply(payload);
      } else if (message.channel?.isTextBased() && typeof message.channel.send === 'function') {
        await message.channel.send(payload);
      } else {
        return false;
      }

      return true;
    } catch (error) {
      this.logger.warn('giveaway.prize_delivery_follow_up_failed', error, {
        channelId: announcementContext.channelId,
        giveawayMessageId: announcementContext.giveawayMessageId,
        guildId: announcementContext.guildId,
        hostId: announcementContext.hostId,
        winnerId
      });
      return false;
    }
  }

  async hydrateReaction(reaction) {
    if (!reaction?.partial) {
      return reaction;
    }

    try {
      return await reaction.fetch();
    } catch (error) {
      this.logger.warn('giveaway.reaction_fetch_failed', error, {
        messageId: reaction.message?.id || null
      });
      return null;
    }
  }

  async hydrateUser(user) {
    if (!user?.partial || typeof user.fetch !== 'function') {
      return user;
    }

    try {
      return await user.fetch();
    } catch (error) {
      this.logger.warn('giveaway.reaction_user_fetch_failed', error, {
        userId: user.id || null
      });
      return null;
    }
  }

  async safeRemoveReactionUser(reaction, userId, giveaway, {
    failureLogMessage = 'giveaway.expired_reaction_remove_failed'
  } = {}) {
    if (!reaction?.users || typeof reaction.users.remove !== 'function') {
      return false;
    }

    try {
      await reaction.users.remove(userId);
      return true;
    } catch (error) {
      if (!isExpectedReactionRemovalError(error)) {
        this.logger.warn(failureLogMessage, error, {
          guildId: giveaway.guildId,
          messageId: giveaway.messageId,
          userId
        });
      }

      return false;
    }
  }

  async safeNotifyEntryCooldownUser(channel, guild, user, giveaway, activeCooldown) {
    const remainingMs = Math.max(
      0,
      Date.parse(activeCooldown?.cooldownEndsAt || '') - Date.now()
    );
    const cooldownLabel = formatDurationWords(remainingMs);
    const dmContent = buildGiveawayEntryCooldownNoticeContent({
      prizeText: giveaway.prizeText,
      guildName: guild?.name || null,
      cooldownLabel
    });

    try {
      await user.send({
        content: dmContent
      });
      return;
    } catch (error) {
      if (!isExpectedDmFailure(error)) {
        this.logger.warn('giveaway.entry_cooldown_dm_failed', error, {
          guildId: giveaway.guildId,
          messageId: giveaway.messageId,
          userId: user.id
        });
      }
    }

    if (!channel?.isTextBased() || typeof channel.send !== 'function') {
      return;
    }

    try {
      const noticeMessage = await channel.send({
        content: `<@${user.id}> ${buildGiveawayEntryCooldownNoticeContent({
          prizeText: giveaway.prizeText,
          cooldownLabel,
          compact: true
        })}`,
        allowedMentions: {
          parse: [],
          users: [user.id]
        }
      });

      this.scheduleEphemeralCleanup(noticeMessage);
    } catch (error) {
      this.logger.warn('giveaway.entry_cooldown_channel_notice_failed', error, {
        channelId: giveaway.channelId,
        guildId: giveaway.guildId,
        messageId: giveaway.messageId,
        userId: user.id
      });
    }
  }

  async safeNotifyExpiredReactionUser(channel, guild, user, giveaway) {
    if (!this.shouldSendExpiredReactionNotice(giveaway.messageId, user.id)) {
      return;
    }

    const dmContent = buildExpiredGiveawayNoticeContent({
      prizeText: giveaway.prizeText,
      guildName: guild?.name || null
    });

    try {
      await user.send({
        content: dmContent
      });
      return;
    } catch (error) {
      if (!isExpectedDmFailure(error)) {
        this.logger.warn('giveaway.expired_reaction_dm_failed', error, {
          guildId: giveaway.guildId,
          messageId: giveaway.messageId,
          userId: user.id
        });
      }
    }

    if (!channel?.isTextBased() || typeof channel.send !== 'function') {
      return;
    }

    try {
      const noticeMessage = await channel.send({
        content: `<@${user.id}> ${buildExpiredGiveawayNoticeContent({
          prizeText: giveaway.prizeText,
          compact: true
        })}`,
        allowedMentions: {
          parse: [],
          users: [user.id]
        }
      });

      this.scheduleEphemeralCleanup(noticeMessage);
    } catch (error) {
      this.logger.warn('giveaway.expired_reaction_channel_notice_failed', error, {
        channelId: giveaway.channelId,
        guildId: giveaway.guildId,
        messageId: giveaway.messageId,
        userId: user.id
      });
    }
  }

  shouldSendExpiredReactionNotice(messageId, userId) {
    const key = `${messageId}:${userId}`;
    const now = Date.now();
    const existingExpiry = this.reactionNoticeCooldowns.get(key) || 0;

    if (existingExpiry > now) {
      return false;
    }

    this.reactionNoticeCooldowns.set(key, now + EXPIRED_REACTION_NOTICE_COOLDOWN_MS);
    this.pruneExpiredReactionNoticeCooldowns(now);
    return true;
  }

  pruneExpiredReactionNoticeCooldowns(now = Date.now()) {
    for (const [key, expiry] of this.reactionNoticeCooldowns.entries()) {
      if (expiry <= now) {
        this.reactionNoticeCooldowns.delete(key);
      }
    }
  }

  scheduleEphemeralCleanup(message, delayMs = EXPIRED_REACTION_FALLBACK_DELETE_DELAY_MS) {
    if (!message || typeof message.delete !== 'function') {
      return;
    }

    const timer = setTimeout(() => {
      void message.delete().catch(() => {});
    }, Math.max(1_000, Math.floor(Number(delayMs) || EXPIRED_REACTION_FALLBACK_DELETE_DELAY_MS)));

    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  }
}

const REQUIRED_GIVEAWAY_LEADERBOARD_PERMISSIONS = Object.freeze([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks
]);

function buildOutcome(outcome, giveaway, {
  entrantCount = giveaway.entrantIds.length
} = {}) {
  return {
    outcome,
    giveaway,
    entrantCount,
    winnerIds: giveaway.winnerIds
  };
}

function buildLeaderboardSchedulerRunContext(executionContext = {}) {
  return {
    scheduledFor: normalizeLogTimestamp(executionContext.dateLocalIso || executionContext.date),
    triggeredAt: normalizeLogTimestamp(executionContext.triggeredAt)
  };
}

function buildLeaderboardRunLogContext(runContext = {}) {
  return {
    scheduledFor: normalizeLogTimestamp(runContext.scheduledFor),
    triggeredAt: normalizeLogTimestamp(runContext.triggeredAt)
  };
}

function resolveLeaderboardPostDateUtc(runContext = {}) {
  const candidates = [
    runContext?.scheduledFor,
    runContext?.triggeredAt,
    new Date().toISOString()
  ];

  for (const candidate of candidates) {
    const timestamp = Date.parse(candidate || '');

    if (Number.isFinite(timestamp)) {
      return new Date(timestamp).toISOString().slice(0, 10);
    }
  }

  return new Date().toISOString().slice(0, 10);
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

function compareGiveawaysByEndAt(left, right) {
  const leftEndAt = Date.parse(left?.endAt || '');
  const rightEndAt = Date.parse(right?.endAt || '');

  if (Number.isFinite(leftEndAt) && Number.isFinite(rightEndAt) && leftEndAt !== rightEndAt) {
    return leftEndAt - rightEndAt;
  }

  if (Number.isFinite(leftEndAt) && !Number.isFinite(rightEndAt)) {
    return -1;
  }

  if (!Number.isFinite(leftEndAt) && Number.isFinite(rightEndAt)) {
    return 1;
  }

  return String(left?.messageId || '').localeCompare(String(right?.messageId || ''));
}

function buildPreferredMemberLabel(member) {
  return (
    normalizeDisplayLabel(member?.displayName) ||
    normalizeDisplayLabel(member?.nickname) ||
    buildPreferredUserLabel(member?.user)
  );
}

function buildPreferredUserLabel(user) {
  return (
    normalizeDisplayLabel(user?.globalName) ||
    normalizeDisplayLabel(user?.username) ||
    normalizeDisplayLabel(user?.tag)
  );
}

function normalizeDisplayLabel(value) {
  const normalized = String(value || '').trim();
  return normalized ? normalized.slice(0, 120) : null;
}

function extractTornIdFromMember(member) {
  const candidates = [
    member?.displayName,
    member?.nickname,
    member?.user?.globalName,
    member?.user?.username
  ];

  for (const candidate of candidates) {
    const tornId = extractTornIdFromText(candidate);

    if (tornId) {
      return tornId;
    }
  }

  return null;
}

function extractTornIdFromUser(user) {
  const candidates = [
    user?.globalName,
    user?.username,
    user?.tag
  ];

  for (const candidate of candidates) {
    const tornId = extractTornIdFromText(candidate);

    if (tornId) {
      return tornId;
    }
  }

  return null;
}

function buildTornProfileUrl(tornId) {
  return `https://www.torn.com/profiles.php?XID=${tornId}`;
}

function buildAnnouncementAllowedMentions(winnerIds = []) {
  return {
    parse: [],
    users: normalizeIdList(winnerIds)
  };
}

function shouldUseProgressiveRussianRouletteReveal(giveaway, gameResult) {
  return (
    normalizeGiveawayGameType(giveaway?.gameType) === 'russian_roulette_standard' &&
    normalizeGiveawayGameType(gameResult?.gameType) === 'russian_roulette_standard' &&
    Array.isArray(gameResult?.detailLines) &&
    gameResult.detailLines.some((line) => /^\d+\./.test(String(line || '').trim()))
  );
}

function splitRussianRouletteDetailLines(detailLines) {
  const normalizedLines = Array.isArray(detailLines)
    ? detailLines.map((line) => String(line || '').trim()).filter(Boolean)
    : [];

  return {
    introLines: normalizedLines.filter((line) => !/^\d+\./.test(line)),
    revealLines: normalizedLines.filter((line) => /^\d+\./.test(line))
  };
}

function buildRussianRouletteRevealMessageContent({
  baseContent = '',
  detailLines = []
} = {}) {
  const sections = [];
  const normalizedBaseContent = String(baseContent || '').trim();
  const normalizedDetailLines = Array.isArray(detailLines)
    ? detailLines.map((line) => String(line || '').trim()).filter(Boolean)
    : [];

  if (normalizedBaseContent) {
    sections.push(normalizedBaseContent);
  }

  sections.push(RUSSIAN_ROULETTE_REVEAL_HEADING);

  if (normalizedDetailLines.length) {
    sections.push(normalizedDetailLines.join('\n'));
  }

  return sections.join('\n\n');
}

function stripRussianRouletteRevealFromMessageContent(content) {
  const normalizedContent = String(content || '').trim();

  if (!normalizedContent) {
    return '';
  }

  const lines = normalizedContent.split(/\r?\n/);
  const headingIndex = lines.findIndex(
    (line) => String(line || '').trim() === RUSSIAN_ROULETTE_REVEAL_HEADING
  );

  if (headingIndex === -1) {
    return normalizedContent;
  }

  return lines
    .slice(0, headingIndex)
    .join('\n')
    .trim();
}

function parsePrizeConfirmationMessage(content) {
  const normalizedContent = normalizePrizeConfirmationContent(content);
  const normalizedTornContent = stripTornPrizeConfirmationPrefix(normalizedContent);

  if (!normalizedTornContent) {
    return null;
  }

  for (const pattern of TORN_PRIZE_CONFIRMATION_PATTERNS) {
    const match = normalizedTornContent.match(pattern);

    if (!match) {
      continue;
    }

    return {
      messageText: match[3] ? String(match[3]).trim() : null,
      rawContent: normalizedContent,
      recipientText: String(match[2] || '').trim(),
      recipientTornId: extractTornIdFromText(match[2]),
      type: 'torn_send',
      valueText: String(match[1] || '').trim()
    };
  }

  if (GENERIC_PRIZE_CONFIRMATION_PATTERNS.some((pattern) => pattern.test(normalizedTornContent))) {
    return {
      rawContent: normalizedContent,
      recipientText: null,
      recipientTornId: null,
      type: 'generic'
    };
  }

  return null;
}

function normalizePrizeConfirmationContent(content) {
  let normalized = String(content || '').trim();

  if (!normalized) {
    return '';
  }

  normalized = stripWrappingPair(normalized, '"', '"');
  normalized = stripWrappingPair(normalized, "'", "'");
  normalized = stripWrappingPair(normalized, '`', '`');
  normalized = stripWrappingPair(normalized, '“', '”');
  normalized = normalized.replace(/^>\s*/, '');

  return normalized.replace(/\s+/g, ' ').trim();
}

function stripTornPrizeConfirmationPrefix(content) {
  return String(content || '')
    .replace(TORN_PRIZE_CONFIRMATION_PREFIX_PATTERN, '')
    .trim();
}

function stripWrappingPair(value, startToken, endToken) {
  const normalized = String(value || '').trim();

  if (!normalized.startsWith(startToken) || !normalized.endsWith(endToken)) {
    return normalized;
  }

  return normalized.slice(startToken.length, normalized.length - endToken.length).trim();
}

function announcementMatchesPrizeConfirmation(announcement, prizeConfirmation) {
  return normalizeWinnerReferences(announcement?.winnerReferences).some((winnerReference) =>
    winnerReferenceMatchesPrizeConfirmation(winnerReference, prizeConfirmation)
  );
}

function hasPrizeConfirmationRecipient(prizeConfirmation) {
  return Boolean(prizeConfirmation?.recipientTornId || prizeConfirmation?.recipientText);
}

function resolveConfirmedWinnerId(message, announcementContext, prizeConfirmation = null) {
  const mentionedWinnerIds = getMentionedUserIds(message).filter((winnerId) =>
    announcementContext.winnerIds.includes(winnerId)
  );

  if (mentionedWinnerIds.length === 1) {
    return mentionedWinnerIds[0];
  }

  const matchedWinnerIds = normalizeWinnerReferences(announcementContext?.winnerReferences)
    .filter((winnerReference) =>
      announcementContext.winnerIds.includes(winnerReference.winnerId) &&
      winnerReferenceMatchesPrizeConfirmation(winnerReference, prizeConfirmation)
    )
    .map((winnerReference) => winnerReference.winnerId);

  if (matchedWinnerIds.length === 1) {
    return matchedWinnerIds[0];
  }

  return announcementContext.winnerIds.length === 1 ? announcementContext.winnerIds[0] : null;
}

function winnerReferenceMatchesPrizeConfirmation(winnerReference, prizeConfirmation) {
  if (!winnerReference || !prizeConfirmation) {
    return false;
  }

  if (
    prizeConfirmation.recipientTornId &&
    winnerReference.tornId &&
    String(prizeConfirmation.recipientTornId) === String(winnerReference.tornId)
  ) {
    return true;
  }

  const recipientKey = canonicalizeWinnerMatchText(prizeConfirmation.recipientText);

  if (!recipientKey) {
    return false;
  }

  return winnerReference.aliases.some(
    (alias) => canonicalizeWinnerMatchText(alias) === recipientKey
  );
}

function collectWinnerReferenceAliases(values) {
  const aliases = new Set();

  for (const value of Array.isArray(values) ? values : []) {
    const normalized = normalizeDisplayLabel(value);

    if (!normalized) {
      continue;
    }

    aliases.add(normalized);

    const withoutTornId = normalizeDisplayLabel(
      normalized
        .replace(/\[\d{4,10}\]/g, ' ')
        .replace(/\(\d{4,10}\)/g, ' ')
    );

    if (withoutTornId) {
      aliases.add(withoutTornId);
    }
  }

  return Array.from(aliases);
}

function normalizeWinnerReferences(value) {
  const winnerReferences = [];
  const seenWinnerIds = new Set();

  for (const entry of Array.isArray(value) ? value : []) {
    const winnerId = String(entry?.winnerId || '').trim();

    if (!winnerId || seenWinnerIds.has(winnerId)) {
      continue;
    }

    seenWinnerIds.add(winnerId);
    winnerReferences.push({
      aliases: collectWinnerReferenceAliases(entry?.aliases),
      tornId: entry?.tornId ? String(entry.tornId).trim() : null,
      winnerId
    });
  }

  return winnerReferences;
}

function canonicalizeWinnerMatchText(value) {
  const normalized = String(value || '').toLowerCase();

  return normalized
    .replace(/\[\d{4,10}\]/g, ' ')
    .replace(/\(\d{4,10}\)/g, ' ')
    .replace(/[^a-z0-9]+/g, '');
}

function formatWinnerAnnouncementTargets(winnerIds, winnerProfiles = []) {
  const resolvedWinnerIds = normalizeIdList(winnerIds);
  const profileMap = new Map(
    (Array.isArray(winnerProfiles) ? winnerProfiles : [])
      .filter((entry) => entry?.winnerId && entry?.profileUrl)
      .map((entry) => [String(entry.winnerId), entry.profileUrl])
  );

  return resolvedWinnerIds.length
    ? resolvedWinnerIds
        .map((winnerId) => {
          const profileUrl = profileMap.get(String(winnerId));
          return profileUrl ? `<@${winnerId}> (${profileUrl})` : `<@${winnerId}>`;
        })
        .join(', ')
    : 'No winners';
}

function truncateTextForAnnouncement(value, maxLength = 1024) {
  const normalized = String(value || '').replace(/@/g, '@\u200b').trim() || 'Unavailable';

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function normalizeIdList(value) {
  return Array.from(
    new Set(
      Array.isArray(value)
        ? value
            .map((entry) => String(entry || '').trim())
            .filter(Boolean)
        : []
    )
  );
}

function toArray(value) {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.slice();
  }

  if (typeof value.values === 'function') {
    return Array.from(value.values());
  }

  return Array.from(value);
}

function getMentionedUserIds(message) {
  return Array.from(message?.mentions?.users?.keys?.() || []);
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, Math.floor(Number(ms) || 0)));

    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  });
}

function isUnrecoverableDiscordError(error) {
  return [10003, 10008, 50001, 50013].includes(Number(error?.code));
}

function isUnknownMemberError(error) {
  return [10007, 10013].includes(Number(error?.code));
}

function isExpectedReactionRemovalError(error) {
  return [10008, 10014, 50001, 50013].includes(Number(error?.code));
}

function isExpectedDmFailure(error) {
  return [50007].includes(Number(error?.code));
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
  GiveawayService
};
