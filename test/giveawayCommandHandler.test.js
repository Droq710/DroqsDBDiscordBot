const assert = require('node:assert/strict');
const test = require('node:test');

const { execute } = require('../src/discord/commandHandlers/giveaway');

test('giveaway start rejects multiple winners for mini-game modes', async () => {
  const interaction = createInteractionStub({
    subcommand: 'start',
    strings: {
      item: 'Rare Plushie',
      duration: '15m',
      game_type: 'dice_duel'
    },
    integers: {
      winners: 2
    }
  });

  await assert.rejects(
    () =>
      execute(interaction, {
        giveawayService: {
          createGiveaway() {
            throw new Error('should not be called');
          }
        },
        logger: createSilentLogger()
      }),
    /Mini-game giveaways resolve to one winner/
  );
});

test('giveaway leaderboard returns a public leaderboard embed', async () => {
  const guild = createLeaderboardGuild({
    cachedMembers: {
      'winner-1': {
        displayName: 'Droq',
        user: {
          username: 'droq-user'
        }
      }
    },
    fetchedMembers: {
      'winner-2': {
        displayName: null,
        user: {
          username: 'Carl'
        }
      }
    },
    fetchErrors: {
      'winner-3': Object.assign(new Error('Unknown Member'), {
        code: 10007
      })
    }
  });
  const interaction = createInteractionStub({
    subcommand: 'leaderboard',
    guild
  });

  await execute(interaction, {
    giveawayService: {
      getLeaderboard() {
        return [
          {
            userId: 'winner-1',
            winCount: 3
          },
          {
            userId: 'winner-2',
            winCount: 2
          },
          {
            userId: 'winner-3',
            winCount: 1
          }
        ];
      }
    },
    logger: createSilentLogger()
  });

  assert.deepEqual(interaction.deferredPayload, {
    ephemeral: false
  });
  assert.equal(Array.isArray(interaction.replyPayload?.embeds), true);
  assert.equal(interaction.replyPayload.embeds[0].data.title, 'Giveaway Leaderboard');
  assert.match(interaction.replyPayload.embeds[0].data.description, /1\. Droq - 3 wins/);
  assert.match(interaction.replyPayload.embeds[0].data.description, /2\. Carl - 2 wins/);
  assert.match(interaction.replyPayload.embeds[0].data.description, /3\. Unknown User - 1 win/);
  assert.deepEqual(guild.fetchedUserIds, ['winner-2', 'winner-3']);
});

function createInteractionStub({
  subcommand = 'start',
  strings = {},
  integers = {},
  booleans = {},
  guild = createLeaderboardGuild()
} = {}) {
  const interaction = {
    deferredPayload: null,
    replyPayload: null,
    guildId: guild.id,
    guild,
    user: {
      id: 'user-1'
    },
    channel: {},
    client: {
      user: {
        id: 'bot-user'
      }
    },
    memberPermissions: {
      has() {
        return true;
      }
    },
    inGuild() {
      return true;
    },
    async deferReply(payload) {
      interaction.deferredPayload = payload;
    },
    async editReply(payload) {
      interaction.replyPayload = payload;
    },
    options: {
      getSubcommand() {
        return subcommand;
      },
      getString(name) {
        return Object.prototype.hasOwnProperty.call(strings, name)
          ? strings[name]
          : null;
      },
      getInteger(name) {
        return Object.prototype.hasOwnProperty.call(integers, name)
          ? integers[name]
          : null;
      },
      getBoolean(name) {
        return Object.prototype.hasOwnProperty.call(booleans, name)
          ? booleans[name]
          : null;
      }
    }
  };

  return interaction;
}

function createLeaderboardGuild({
  cachedMembers = {},
  fetchedMembers = {},
  fetchErrors = {}
} = {}) {
  const cacheEntries = Object.entries(cachedMembers).map(([userId, member]) => [
    userId,
    {
      id: userId,
      displayName: member.displayName ?? null,
      user: {
        username: member.user?.username ?? null
      }
    }
  ]);
  const fetchedUserIds = [];

  return {
    id: 'guild-1',
    name: 'DroqsDB',
    fetchedUserIds,
    members: {
      cache: new Map(cacheEntries),
      async fetch(userId) {
        fetchedUserIds.push(userId);

        if (Object.prototype.hasOwnProperty.call(fetchErrors, userId)) {
          throw fetchErrors[userId];
        }

        if (!Object.prototype.hasOwnProperty.call(fetchedMembers, userId)) {
          throw Object.assign(new Error('Unknown Member'), {
            code: 10007
          });
        }

        const member = fetchedMembers[userId];
        return {
          id: userId,
          displayName: member.displayName ?? null,
          user: {
            username: member.user?.username ?? null
          }
        };
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
