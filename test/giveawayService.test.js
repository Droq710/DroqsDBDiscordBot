const assert = require('node:assert/strict');
const test = require('node:test');

const { GiveawayService } = require('../src/services/giveaway');

test('GiveawayService rejects entries when the winner cooldown is active', async () => {
  let giveaway = createGiveawayRecord({
    endMode: 'time',
    winnerCooldownEnabled: true
  });
  let removedReactionUserId = null;
  let notifiedCooldown = null;

  const store = {
    getGiveawayByMessageId(messageId) {
      return messageId === giveaway.messageId ? giveaway : null;
    },
    getWinnerCooldownByUserId(userId) {
      return userId === 'user-1'
        ? {
            userId,
            cooldownEndsAt: '2099-01-01T00:03:00.000Z'
          }
        : null;
    },
    updateGiveawayBlockedEntries({
      blockedEntryIds
    }) {
      giveaway = {
        ...giveaway,
        blockedEntryIds
      };
      return giveaway;
    }
  };
  const service = new GiveawayService({
    discordClient: createDiscordClientStub(),
    giveawayStore: store,
    logger: createSilentLogger()
  });

  service.safeNotifyEntryCooldownUser = async (...args) => {
    notifiedCooldown = args;
  };

  await service.handleReactionAdd(
    {
      partial: false,
      emoji: {
        name: '✈️'
      },
      message: {
        id: giveaway.messageId,
        channel: {},
        guild: {}
      },
      users: {
        async remove(userId) {
          removedReactionUserId = userId;
        }
      }
    },
    {
      id: 'user-1',
      bot: false
    }
  );

  assert.equal(removedReactionUserId, 'user-1');
  assert.deepEqual(giveaway.blockedEntryIds, ['user-1']);
  assert.ok(notifiedCooldown);
});

test('GiveawayService closes entry-target giveaways with an accepted entrant snapshot', async () => {
  const giveaway = createGiveawayRecord({
    endMode: 'entries',
    maxEntries: 2,
    blockedEntryIds: ['blocked-user']
  });
  let closeRequest = null;

  const service = new GiveawayService({
    discordClient: createDiscordClientStub(),
    giveawayStore: {
      getGiveawayByMessageId(messageId) {
        return messageId === giveaway.messageId ? giveaway : null;
      },
      getWinnerCooldownByUserId() {
        return null;
      },
      updateGiveawayBlockedEntries() {
        return giveaway;
      }
    },
    logger: createSilentLogger()
  });

  service.endGiveawayByMessageId = async (messageId, options = {}) => {
    closeRequest = {
      messageId,
      options
    };
    return {};
  };

  await service.handleReactionAdd(
    {
      partial: false,
      emoji: {
        name: '✈️'
      },
      message: {
        id: giveaway.messageId,
        channel: {},
        guild: {}
      },
      users: {
        async fetch() {
          return new Map([
            ['user-1', { id: 'user-1' }],
            ['user-2', { id: 'user-2' }],
            ['blocked-user', { id: 'blocked-user' }],
            ['bot-user', { id: 'bot-user' }]
          ]);
        }
      }
    },
    {
      id: 'user-2',
      bot: false
    }
  );

  assert.equal(closeRequest.messageId, giveaway.messageId);
  assert.equal(closeRequest.options.initiatedBy, 'system');
  assert.deepEqual(
    closeRequest.options.entrantIdsSnapshot.sort(),
    ['user-1', 'user-2']
  );
});

test('GiveawayService posts the giveaway leaderboard once per day into #giveaways', async () => {
  const sentPayloads = [];
  const logger = createLoggerSpy();
  const leaderboardClaims = [];
  let completedPost = null;
  let failedPost = null;
  const channel = createLeaderboardChannel({
    async sendImpl(payload) {
      sentPayloads.push(payload);
      return {
        id: 'leaderboard-msg-1'
      };
    }
  });
  const guild = createLeaderboardGuild({
    channel,
    memberLabels: {
      'winner-1': 'Winner One Live',
      'winner-2': 'Winner Two Live'
    }
  });
  const store = {
    listGiveawayLeaderboard(guildId) {
      return guildId === guild.id
        ? [
            {
              userId: 'winner-1',
              storedLabel: 'Winner One',
              winCount: 4
            },
            {
              userId: 'winner-2',
              storedLabel: 'Winner Two',
              winCount: 2
            }
          ]
        : [];
    },
    tryBeginLeaderboardPost(payload) {
      leaderboardClaims.push(payload);
      return leaderboardClaims.length === 1;
    },
    markLeaderboardPostCompleted(payload) {
      completedPost = payload;
    },
    markLeaderboardPostFailed(payload) {
      failedPost = payload;
    }
  };
  const service = new GiveawayService({
    discordClient: createLeaderboardDiscordClient(guild),
    giveawayStore: store,
    logger
  });

  await service.postLeaderboardForGuild(guild, {
    scheduledFor: '2026-04-02T23:00:00.000Z',
    triggeredAt: '2026-04-02T23:00:01.000Z'
  });
  await service.postLeaderboardForGuild(guild, {
    scheduledFor: '2026-04-02T23:00:00.000Z',
    triggeredAt: '2026-04-02T23:05:00.000Z'
  });

  assert.equal(sentPayloads.length, 1);
  assert.equal(Array.isArray(sentPayloads[0].embeds), true);
  assert.equal(sentPayloads[0].embeds[0].data.title, 'Giveaway Leaderboard');
  assert.match(sentPayloads[0].embeds[0].data.description, /1\. Winner One Live - 4 wins/);
  assert.equal(leaderboardClaims[0].postDateUtc, '2026-04-02');
  assert.deepEqual(completedPost, {
    guildId: 'guild-1',
    postDateUtc: '2026-04-02',
    channelId: 'channel-giveaways',
    messageId: 'leaderboard-msg-1',
    completedAt: completedPost.completedAt
  });
  assert.equal(failedPost, null);
  assert.equal(
    logger.entries.some((entry) => entry.message === 'leaderboard.post_started'),
    true
  );
  assert.equal(
    logger.entries.some((entry) => entry.message === 'leaderboard.post_completed'),
    true
  );
});

test('GiveawayService skips leaderboard autoposting when a guild has no wins yet', async () => {
  const logger = createLoggerSpy();
  const service = new GiveawayService({
    discordClient: createLeaderboardDiscordClient(
      createLeaderboardGuild({
        channel: createLeaderboardChannel()
      })
    ),
    giveawayStore: {
      listGiveawayLeaderboard() {
        return [];
      }
    },
    logger
  });
  const guild = createLeaderboardGuild({
    channel: createLeaderboardChannel()
  });

  await service.postLeaderboardForGuild(guild, {
    scheduledFor: '2026-04-02T23:00:00.000Z',
    triggeredAt: '2026-04-02T23:00:01.000Z'
  });

  assert.equal(
    logger.entries.some((entry) => entry.message === 'leaderboard.post_skipped_no_wins'),
    true
  );
});

function createGiveawayRecord(overrides = {}) {
  return {
    messageId: '100000000000000001',
    guildId: '200000000000000001',
    channelId: '300000000000000001',
    hostId: '400000000000000001',
    prizeText: 'Rare Plushie',
    winnerCount: 1,
    durationMs: 15 * 60 * 1000,
    endAt: '2099-01-01T00:15:00.000Z',
    endMode: 'time',
    gameType: 'standard',
    maxEntries: null,
    winnerCooldownEnabled: false,
    winnerCooldownMs: 3 * 60 * 1000,
    status: 'active',
    entrantIds: [],
    winnerIds: [],
    blockedEntryIds: [],
    createdAt: '2099-01-01T00:00:00.000Z',
    endedAt: null,
    rerolledAt: null,
    rerolledBy: null,
    updatedAt: '2099-01-01T00:00:00.000Z',
    ...overrides
  };
}

function createDiscordClientStub() {
  return {
    user: {
      id: 'bot-user'
    },
    channels: {
      async fetch() {
        return null;
      }
    },
    guilds: {
      cache: new Map(),
      async fetch() {
        return null;
      }
    }
  };
}

function createLeaderboardDiscordClient(guild) {
  return {
    user: {
      id: 'bot-user'
    },
    guilds: {
      cache: new Map([[guild.id, guild]])
    },
    users: {
      async fetch(userId) {
        return {
          id: userId,
          username: `user-${userId}`
        };
      }
    }
  };
}

function createLeaderboardGuild({
  channel,
  memberLabels = {}
} = {}) {
  return {
    id: 'guild-1',
    name: 'DroqsDB',
    channels: {
      cache: new Map([[channel.id, channel]]),
      async fetch() {
        return this.cache;
      }
    },
    members: {
      async fetch(userId) {
        return {
          id: userId,
          displayName: memberLabels[userId] || null,
          nickname: null,
          user: {
            username: memberLabels[userId] || `user-${userId}`,
            globalName: null
          }
        };
      }
    }
  };
}

function createLeaderboardChannel({
  sendImpl = async (payload) => payload
} = {}) {
  return {
    id: 'channel-giveaways',
    guildId: 'guild-1',
    name: 'giveaways',
    isTextBased() {
      return true;
    },
    permissionsFor() {
      return {
        has() {
          return true;
        }
      };
    },
    async send(payload) {
      return sendImpl(payload);
    }
  };
}

function createLoggerSpy() {
  const entries = [];

  return {
    entries,
    info(message, ...args) {
      entries.push({
        level: 'info',
        message,
        args
      });
    },
    warn(message, ...args) {
      entries.push({
        level: 'warn',
        message,
        args
      });
    },
    error(message, ...args) {
      entries.push({
        level: 'error',
        message,
        args
      });
    }
  };
}

function createSilentLogger() {
  return {
    info() {},
    warn() {},
    error() {}
  };
}
