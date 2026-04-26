const assert = require('node:assert/strict');
const test = require('node:test');

const { AlertService } = require('../src/services/alertService');

test('AlertService triggers available-now alerts once', async () => {
  const sentMessages = [];
  const store = createMemoryAlertStore([
    {
      id: 1,
      guildId: 'guild-1',
      channelId: 'channel-1',
      userId: 'user-1',
      itemName: 'Xanax',
      country: 'Mexico',
      mode: 'available',
      status: 'active'
    }
  ]);
  const service = new AlertService({
    discordClient: createDiscordClient(sentMessages),
    droqsdbClient: {
      async getItemCountrySnapshot() {
        return {
          countryRow: {
            stock: 5
          }
        };
      }
    },
    alertStore: store,
    logger: createSilentLogger()
  });

  await service.runOnce();
  await service.runOnce();

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].content, /<@user-1> Alert: Xanax is available in Mexico right now/);
  assert.equal(store.alerts[0].status, 'triggered');
});

test('AlertService handles API failure without disabling an alert', async () => {
  const store = createMemoryAlertStore([
    {
      id: 1,
      guildId: 'guild-1',
      channelId: 'channel-1',
      userId: 'user-1',
      itemName: 'Xanax',
      country: 'Mexico',
      mode: 'available',
      status: 'active'
    }
  ]);
  const service = new AlertService({
    discordClient: createDiscordClient([]),
    droqsdbClient: {
      async getItemCountrySnapshot() {
        throw new Error('API down');
      }
    },
    alertStore: store,
    logger: createSilentLogger()
  });

  await service.runOnce();

  assert.equal(store.alerts[0].status, 'active');
  assert.equal(store.alerts[0].triggeredAt, undefined);
});

test('AlertService fly-out alerts use the DroqsDB travel planner', async () => {
  const sentMessages = [];
  let capturedQuery = null;
  const store = createMemoryAlertStore([
    {
      id: 1,
      guildId: 'guild-1',
      channelId: 'channel-1',
      userId: 'user-1',
      itemName: 'Xanax',
      country: 'Mexico',
      mode: 'flyout',
      flightType: 'private',
      capacity: 19,
      status: 'active'
    }
  ]);
  const service = new AlertService({
    discordClient: createDiscordClient(sentMessages),
    droqsdbClient: {
      async queryTravelPlanner(query) {
        capturedQuery = query;
        return {
          runs: [
            {
              itemName: 'Xanax',
              country: 'Mexico',
              stock: 0,
              availabilityState: 'projected_on_arrival',
              isProjectedViable: true,
              departInMinutes: 0
            }
          ]
        };
      }
    },
    alertStore: store,
    logger: createSilentLogger()
  });

  await service.runOnce();

  assert.deepEqual(capturedQuery, {
    countries: ['Mexico'],
    itemNames: ['Xanax'],
    limit: 10,
    settings: {
      flightType: 'private',
      capacity: 19
    }
  });
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].content, /Fly-out alert: Leave for Mexico now/);
});

function createMemoryAlertStore(alerts) {
  return {
    alerts,
    async initialize() {},
    close() {},
    listActiveAlerts() {
      return this.alerts.filter((alert) => alert.status === 'active' && !alert.triggeredAt);
    },
    markAlertChecked({ id }) {
      const alert = this.alerts.find((entry) => entry.id === id);
      alert.lastCheckedAt = new Date().toISOString();
    },
    markAlertTriggered({ id }) {
      const alert = this.alerts.find((entry) => entry.id === id);
      alert.status = 'triggered';
      alert.triggeredAt = new Date().toISOString();
    },
    markAlertSendFailed({ id, reason }) {
      const alert = this.alerts.find((entry) => entry.id === id);
      alert.status = 'disabled';
      alert.disabledReason = reason;
    }
  };
}

function createDiscordClient(sentMessages) {
  return {
    channels: {
      async fetch() {
        return {
          isTextBased() {
            return true;
          },
          async send(payload) {
            sentMessages.push(payload);
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
