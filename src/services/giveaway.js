const {
  buildGiveawayEntryCooldownNoticeContent,
  buildExpiredGiveawayNoticeContent,
  buildGiveawayAnnouncementContent,
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
const PRIZE_DELIVERY_FORUM_URL =
  'https://www.torn.com/forums.php#/p=threads&f=14&t=16551076';
const PRIZE_CONFIRMATION_PATTERNS = Object.freeze([
  /\b(?:prize|reward|winnings|payout|payment)\s+(?:was\s+|has\s+been\s+)?sent\b/i,
  /\bsent\s+(?:the\s+)?(?:prize|reward|winnings|payout|payment|cash|item|trade)\b/i,
  /\b(?:trade|payout|payment)\s+sent\b/i,
  /\b(?:prize|reward|winnings|payout|payment)\s+delivered\b/i,
  /\bpaid\s+out\b/i
]);

class GiveawayService {
  constructor({
    discordClient,
    giveawayStore,
    logger = console
  }) {
    this.discordClient = discordClient;
    this.giveawayStore = giveawayStore;
    this.logger = logger;
    this.timers = new Map();
    this.inFlightMessageIds = new Set();
    this.entryCloseSnapshots = new Map();
    this.reactionNoticeCooldowns = new Map();
    this.recentGiveawayAnnouncements = new Map();
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
    this.giveawayStore.close();
    this.started = false;
    this.logger.info('giveaway.scheduler_stopped');
  }

  getGiveaway(messageId) {
    return this.giveawayStore.getGiveawayByMessageId(messageId);
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
          const endedGiveaway = this.giveawayStore.markGiveawayEnded({
            messageId: normalizedMessageId,
            entrantIds: currentGiveaway.entrantIds,
            winnerIds: [],
            endedAt: new Date().toISOString()
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
    const updatedGiveaway = this.giveawayStore.updateGiveawayWinners({
      messageId: normalizedMessageId,
      winnerIds: gameResult.winnerIds,
      rerolledAt,
      rerolledBy
    });
    this.startWinnerCooldowns(updatedGiveaway, {
      startedAt: rerolledAt
    });

    let messageEdited = false;
    let announcementSent = false;

    try {
      const { channel, message } = await this.fetchGiveawayMessage(updatedGiveaway);
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

    if (!content || !isPrizeConfirmationMessage(content)) {
      return;
    }

    const announcementContext = this.findRecentGiveawayAnnouncement(message);

    if (!announcementContext) {
      return;
    }

    const winnerId = resolveConfirmedWinnerId(message, announcementContext);

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
    const timer = setTimeout(() => {
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
    }, delayMs);

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
    const endedAt = new Date().toISOString();
    const endedGiveaway = this.giveawayStore.markGiveawayEnded({
      messageId: giveaway.messageId,
      entrantIds,
      winnerIds: gameResult.winnerIds,
      endedAt
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

  async safeSendAnnouncement(channel, giveaway, {
    rerolled = false,
    eligibleEntrantCount = null,
    gameResult = null
  } = {}) {
    let winnerProfiles = [];

    try {
      winnerProfiles = await this.resolveWinnerAnnouncementProfiles(giveaway);
    } catch (error) {
      this.logger.warn('giveaway.winner_profile_resolution_failed', error, {
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

    try {
      const announcementMessage = await channel.send({
        content,
        allowedMentions: {
          parse: [],
          users: giveaway.winnerIds
        }
      });
      this.recordRecentGiveawayAnnouncement(giveaway, {
        announcementMessageId: announcementMessage?.id || null
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

  async resolveWinnerAnnouncementProfiles(giveaway) {
    const winnerIds = Array.isArray(giveaway?.winnerIds) ? giveaway.winnerIds : [];

    if (!winnerIds.length) {
      return [];
    }

    const guild = await this.fetchGuild(giveaway.guildId);

    if (!guild?.members || typeof guild.members.fetch !== 'function') {
      return [];
    }

    const profiles = await Promise.all(
      winnerIds.map((winnerId) =>
        this.resolveWinnerAnnouncementProfile(guild, winnerId, {
          guildId: giveaway.guildId,
          messageId: giveaway.messageId
        })
      )
    );

    return profiles.filter(Boolean);
  }

  async resolveWinnerAnnouncementProfile(guild, winnerId, {
    guildId,
    messageId
  } = {}) {
    try {
      const member = await guild.members.fetch(winnerId);
      return buildWinnerAnnouncementProfile(member, winnerId);
    } catch (error) {
      if (!isUnknownMemberError(error)) {
        this.logger.warn('giveaway.winner_member_fetch_failed', error, {
          guildId,
          messageId,
          userId: winnerId
        });
      }

      return null;
    }
  }

  recordRecentGiveawayAnnouncement(giveaway, {
    announcementMessageId = null
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
      winnerIds: Array.isArray(giveaway.winnerIds) ? giveaway.winnerIds.slice() : []
    });
    this.trimRecentGiveawayAnnouncements();
  }

  findRecentGiveawayAnnouncement(message) {
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
        `<@${winnerId}> your prize should be with you now. ` +
        `When you have a moment, please share your win on the DroqsDB forum: ${PRIZE_DELIVERY_FORUM_URL}`,
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

function buildWinnerAnnouncementProfile(member, winnerId) {
  const tornId = extractTornIdFromMember(member);

  if (!tornId) {
    return null;
  }

  return {
    winnerId: String(winnerId),
    tornId,
    profileUrl: buildTornProfileUrl(tornId)
  };
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

function buildTornProfileUrl(tornId) {
  return `https://www.torn.com/profiles.php?XID=${tornId}`;
}

function isPrizeConfirmationMessage(content) {
  return PRIZE_CONFIRMATION_PATTERNS.some((pattern) => pattern.test(content));
}

function resolveConfirmedWinnerId(message, announcementContext) {
  const mentionedWinnerIds = getMentionedUserIds(message).filter((winnerId) =>
    announcementContext.winnerIds.includes(winnerId)
  );

  if (mentionedWinnerIds.length === 1) {
    return mentionedWinnerIds[0];
  }

  return announcementContext.winnerIds.length === 1 ? announcementContext.winnerIds[0] : null;
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

module.exports = {
  GiveawayService
};
