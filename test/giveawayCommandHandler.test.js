const assert = require('node:assert/strict');
const test = require('node:test');

const { execute } = require('../src/discord/commandHandlers/giveaway');

test('giveaway start rejects multiple winners for mini-game modes', async () => {
  const interaction = createInteractionStub({
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

function createInteractionStub({
  strings = {},
  integers = {},
  booleans = {}
} = {}) {
  return {
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
    async deferReply() {},
    async editReply() {},
    options: {
      getSubcommand() {
        return 'start';
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
}

function createSilentLogger() {
  return {
    info() {},
    warn() {},
    error() {}
  };
}
