const {
  buildExpiredGiveawayNoticeContent,
  buildGiveawayAnnouncementContent,
  buildGiveawayEmbed
} = require('../utils/giveawayFormatters');
const {
  GIVEAWAY_EMOJI,
  chooseRandomEntries,
  isGiveawayExpired,
  normalizeEmojiName,
  normalizeGiveawayMessageId
} = require('../utils/giveaway');

const EXPIRED_REACTION_NOTICE_COOLDOWN_MS = 10 * 60 * 1000;
const EXPIRED_REACTION_FALLBACK_DELETE_DELAY_MS = 15_000;
const GIVEAWAYS_ROLE_NAME = 'Giveaways';

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
    this.reactionNoticeCooldowns = new Map();
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
    this.reactionNoticeCooldowns.clear();
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
    durationMs
  }) {
    const endAt = new Date(Date.now() + durationMs).toISOString();
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
            status: 'active'
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
        endAt
      });

      await message.react(GIVEAWAY_EMOJI);
      this.scheduleGiveaway(createdGiveaway);

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
    initiatedBy = 'system'
  } = {}) {
    const normalizedMessageId = normalizeGiveawayMessageId(messageId);
    let giveaway = this.giveawayStore.getGiveawayByMessageId(normalizedMessageId);

    if (!giveaway) {
      throw new Error('No giveaway was found for that message ID.');
    }

    if (giveaway.status === 'ended') {
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
        initiatedBy
      });

      this.logger.info('giveaway.ended', {
        announcementSent: result.announcementSent,
        entrantCount: result.entrantCount,
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
    const winnerIds = chooseRandomEntries(eligibleEntrantIds, giveaway.winnerCount);
    const rerolledAt = new Date().toISOString();
    const updatedGiveaway = this.giveawayStore.updateGiveawayWinners({
      messageId: normalizedMessageId,
      winnerIds,
      rerolledAt,
      rerolledBy
    });

    let messageEdited = false;
    let announcementSent = false;

    try {
      const { channel, message } = await this.fetchGiveawayMessage(updatedGiveaway);
      messageEdited = await this.safeEditGiveawayMessage(message, updatedGiveaway, {
        eligibleEntrantCount: eligibleEntrantIds.length
      });
      announcementSent = await this.safeSendAnnouncement(channel, updatedGiveaway, {
        rerolled: true,
        eligibleEntrantCount: eligibleEntrantIds.length
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
      messageEdited,
      messageId: updatedGiveaway.messageId,
      winnerCount: updatedGiveaway.winnerIds.length
    });

    return {
      ...buildOutcome('rerolled', updatedGiveaway, {
        entrantCount: eligibleEntrantIds.length
      }),
      announcementSent,
      messageEdited
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

    if (!isGiveawayExpired(giveaway)) {
      return;
    }

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
  }

  scheduleGiveaway(giveaway) {
    if (!giveaway?.messageId) {
      return;
    }

    this.clearScheduledGiveaway(giveaway.messageId);

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

  async finalizeGiveaway(giveaway) {
    const { channel, message } = await this.fetchGiveawayMessage(giveaway);
    const entrantIds = await this.collectEntrantIds(message, giveaway);
    const winnerIds = chooseRandomEntries(entrantIds, giveaway.winnerCount);
    const endedGiveaway = this.giveawayStore.markGiveawayEnded({
      messageId: giveaway.messageId,
      entrantIds,
      winnerIds,
      endedAt: new Date().toISOString()
    });
    const messageEdited = await this.safeEditGiveawayMessage(message, endedGiveaway, {
      eligibleEntrantCount: entrantIds.length
    });
    const announcementSent = await this.safeSendAnnouncement(channel, endedGiveaway, {
      rerolled: false,
      eligibleEntrantCount: entrantIds.length
    });

    return {
      ...buildOutcome('ended', endedGiveaway, {
        entrantCount: entrantIds.length
      }),
      announcementSent,
      messageEdited
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
    const reaction = await this.getGiveawayReaction(message);

    if (!reaction) {
      return [];
    }

    const users = await reaction.users.fetch();
    const botUserId = this.discordClient.user?.id || null;
    const entrantIds = Array.from(
      new Set(
        users
          .filter((user) => user.id !== botUserId)
          .map((user) => user.id)
      )
    );

    return this.resolveEligibleEntrantIds(giveaway.guildId, entrantIds, {
      messageId: giveaway.messageId
    });
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
    eligibleEntrantCount = null
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
            winnerIds: giveaway.winnerIds,
            entrantCount: giveaway.entrantIds.length,
            eligibleEntrantCount,
            endedAt: giveaway.endedAt,
            rerolledAt: giveaway.rerolledAt
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
    eligibleEntrantCount = null
  } = {}) {
    const content = buildGiveawayAnnouncementContent({
      prizeText: giveaway.prizeText,
      winnerIds: giveaway.winnerIds,
      entrantCount: giveaway.entrantIds.length,
      eligibleEntrantCount,
      winnerCount: giveaway.winnerCount,
      rerolled
    });

    try {
      await channel.send({
        content,
        allowedMentions: {
          parse: [],
          users: giveaway.winnerIds
        }
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

  async safeRemoveReactionUser(reaction, userId, giveaway) {
    if (!reaction?.users || typeof reaction.users.remove !== 'function') {
      return false;
    }

    try {
      await reaction.users.remove(userId);
      return true;
    } catch (error) {
      if (!isExpectedReactionRemovalError(error)) {
        this.logger.warn('giveaway.expired_reaction_remove_failed', error, {
          guildId: giveaway.guildId,
          messageId: giveaway.messageId,
          userId
        });
      }

      return false;
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
