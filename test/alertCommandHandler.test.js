const assert = require('node:assert/strict');
const test = require('node:test');

const { execute } = require('../src/discord/commandHandlers/alert');

test('alert create stores an alert', async () => {
  let createdPayload = null;
  const interaction = createInteractionStub({
    subcommand: 'create',
    strings: {
      item: 'xanax',
      country: 'mexico',
      mode: 'available'
    }
  });

  await execute(interaction, {
    alertService: {
      countActiveAlertsForUser() {
        return 0;
      },
      createAlert(payload) {
        createdPayload = payload;
        return {
          id: 7,
          ...payload
        };
      }
    },
    droqsdbClient: createDroqsdbClientStub(),
    logger: createSilentLogger()
  });

  assert.deepEqual(interaction.deferredPayload, {
    ephemeral: true
  });
  assert.equal(createdPayload.itemName, 'Xanax');
  assert.equal(createdPayload.country, 'Mexico');
  assert.equal(createdPayload.mode, 'available');
  assert.match(interaction.replyPayload.embeds[0].data.description, /ID: 7/);
});

test('alert list shows user alerts', async () => {
  const interaction = createInteractionStub({
    subcommand: 'list'
  });

  await execute(interaction, {
    alertService: {
      listUserAlerts() {
        return [
          {
            id: 4,
            mode: 'available',
            itemName: 'Xanax',
            country: 'Mexico'
          }
        ];
      }
    },
    logger: createSilentLogger()
  });

  assert.match(interaction.replyPayload.embeds[0].data.description, /#4 - Available now - Xanax in Mexico/);
});

test('alert remove disables the requested alert', async () => {
  let removedPayload = null;
  const interaction = createInteractionStub({
    subcommand: 'remove',
    integers: {
      id: 4
    }
  });

  await execute(interaction, {
    alertService: {
      removeUserAlert(payload) {
        removedPayload = payload;
        return true;
      }
    },
    logger: createSilentLogger()
  });

  assert.equal(removedPayload.id, 4);
  assert.equal(removedPayload.reason, 'user_removed');
  assert.match(interaction.replyPayload.embeds[0].data.description, /Alert 4 has been removed/);
});

test('alert flyout create rejects when no planner client is available', async () => {
  const interaction = createInteractionStub({
    subcommand: 'create',
    strings: {
      item: 'xanax',
      country: 'mexico',
      mode: 'flyout'
    }
  });

  await assert.rejects(
    () =>
      execute(interaction, {
        alertService: {
          countActiveAlertsForUser() {
            return 0;
          }
        },
        droqsdbClient: {
          getItemCountrySnapshot: createDroqsdbClientStub().getItemCountrySnapshot
        },
        logger: createSilentLogger()
      }),
    /Fly-out alerts need a DroqsDB travel planner API endpoint/
  );
});

function createInteractionStub({
  subcommand = 'create',
  strings = {},
  integers = {}
} = {}) {
  const interaction = {
    deferredPayload: null,
    replyPayload: null,
    guildId: 'guild-1',
    channelId: 'channel-1',
    user: {
      id: 'user-1'
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
      getString(name, required = false) {
        if (Object.prototype.hasOwnProperty.call(strings, name)) {
          return strings[name];
        }

        if (required) {
          throw new Error(`Missing required string: ${name}`);
        }

        return null;
      },
      getInteger(name, required = false) {
        if (Object.prototype.hasOwnProperty.call(integers, name)) {
          return integers[name];
        }

        if (required) {
          throw new Error(`Missing required integer: ${name}`);
        }

        return null;
      }
    }
  };

  return interaction;
}

function createDroqsdbClientStub() {
  return {
    async getItemCountrySnapshot() {
      return {
        item: {
          itemName: 'Xanax'
        },
        country: 'Mexico',
        countryRow: {
          stock: 0
        }
      };
    },
    async queryTravelPlanner() {
      return {
        runs: []
      };
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
