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
  const interaction = createInteractionStub({
    subcommand: 'leaderboard'
  });

  await execute(interaction, {
    giveawayService: {
      getLeaderboard() {
        return [
          {
            userId: 'winner-1',
            storedLabel: 'Winner One',
            winCount: 3
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
  assert.match(interaction.replyPayload.embeds[0].data.description, /Winner One - 3 wins/);
});

function createInteractionStub({
  subcommand = 'start',
  strings = {},
  integers = {},
  booleans = {}
} = {}) {
  const interaction = {
    deferredPayload: null,
    replyPayload: null,
    guildId: 'guild-1',
    guild: {
      name: 'DroqsDB'
    },
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

function createSilentLogger() {
  return {
    info() {},
    warn() {},
    error() {}
  };
}
