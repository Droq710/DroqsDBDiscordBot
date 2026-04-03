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

function createSilentLogger() {
  return {
    info() {},
    warn() {},
    error() {}
  };
}
