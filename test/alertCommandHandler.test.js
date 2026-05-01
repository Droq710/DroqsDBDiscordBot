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
  assert.equal(createdPayload.repeatMode, 'once');
  assert.equal(createdPayload.flightType, 'private');
  assert.equal(createdPayload.capacity, 19);
  assert.equal(createdPayload.sellTarget, 'market');
  assert.equal(createdPayload.marketTax, true);
  assert.match(interaction.replyPayload.embeds[0].data.description, /ID: 7/);
  assert.match(interaction.replyPayload.embeds[0].data.description, /Repeat: Once/);
  assert.match(interaction.replyPayload.embeds[0].data.description, /I will DM you once/);
});

test('alert create stores explicit one-time repeat mode', async () => {
  let createdPayload = null;
  const interaction = createInteractionStub({
    subcommand: 'create',
    strings: {
      item: 'xanax',
      country: 'mexico',
      mode: 'available',
      repeat: 'once'
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
          id: 8,
          ...payload
        };
      }
    },
    droqsdbClient: createDroqsdbClientStub(),
    logger: createSilentLogger()
  });

  assert.equal(createdPayload.repeatMode, 'once');
  assert.equal(createdPayload.lastConditionState, null);
});

test('alert create stores recurring repeat mode', async () => {
  let createdPayload = null;
  const interaction = createInteractionStub({
    subcommand: 'create',
    strings: {
      item: 'xanax',
      country: 'mexico',
      mode: 'available',
      repeat: 'every_time'
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
          id: 9,
          ...payload
        };
      }
    },
    droqsdbClient: createDroqsdbClientStub(),
    logger: createSilentLogger()
  });

  assert.equal(createdPayload.repeatMode, 'every_time');
  assert.equal(createdPayload.lastConditionState, false);
  assert.match(interaction.replyPayload.embeds[0].data.description, /Repeat: Every time/);
  assert.match(interaction.replyPayload.embeds[0].data.description, /every time it comes back in stock/);
});

test('alert create accepts flight type and capacity', async () => {
  let createdPayload = null;
  const interaction = createInteractionStub({
    subcommand: 'create',
    strings: {
      item: 'xanax',
      country: 'japan',
      mode: 'flyout',
      flight_type: 'airstrip'
    },
    integers: {
      capacity: 29
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
          id: 10,
          ...payload
        };
      }
    },
    droqsdbClient: createDroqsdbClientStub({
      country: 'Japan'
    }),
    logger: createSilentLogger()
  });

  assert.equal(createdPayload.flightType, 'airstrip');
  assert.equal(createdPayload.capacity, 29);
  assert.equal(createdPayload.sellTarget, 'market');
  assert.equal(createdPayload.marketTax, true);
  assert.match(interaction.replyPayload.embeds[0].data.description, /Flight: Airstrip/);
  assert.match(interaction.replyPayload.embeds[0].data.description, /Capacity: 29/);
  assert.match(interaction.replyPayload.embeds[0].data.description, /I will DM you/);
});

test('alert create validates capacity', async () => {
  const interaction = createInteractionStub({
    subcommand: 'create',
    strings: {
      item: 'xanax',
      country: 'japan',
      mode: 'flyout'
    },
    integers: {
      capacity: 0
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
        droqsdbClient: createDroqsdbClientStub(),
        logger: createSilentLogger()
      }),
    /Capacity must be a whole number/
  );
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
            repeatMode: 'every_time',
            itemName: 'Xanax',
            country: 'Mexico',
            flightType: 'airstrip',
            capacity: 29
          }
        ];
      }
    },
    droqsdbClient: createDroqsdbClientStub(),
    logger: createSilentLogger()
  });

  assert.match(interaction.replyPayload.embeds[0].data.description, /#4 \/ Xanax \/ Mexico \/ Available \/ Every time \/ Airstrip \/ Cap 29/);
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

test('alert create rejects when no alert preview client is available', async () => {
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
    /Alerts need the DroqsDB alert preview API endpoint/
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

function createDroqsdbClientStub({
  itemName = 'Xanax',
  country = 'Mexico'
} = {}) {
  return {
    async getItemCountrySnapshot() {
      return {
        item: {
          itemName
        },
        country,
        countryRow: {
          stock: 0
        }
      };
    },
    getBotAlertPreviewSettings(overrides = {}) {
      return {
        flightType: overrides.flightType || 'private',
        capacity: overrides.capacity ?? 19,
        sellTarget: overrides.sellTarget || 'market',
        marketTax: typeof overrides.marketTax === 'boolean' ? overrides.marketTax : true
      };
    },
    async queryAlertPreview() {
      return {
        ok: true,
        shouldNotifyNow: false
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
