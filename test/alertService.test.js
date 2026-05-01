const assert = require('node:assert/strict');
const test = require('node:test');

const { AlertService } = require('../src/services/alertService');

test('AlertService triggers available-now alerts once via DM', async () => {
  const sentMessages = [];
  const store = createMemoryAlertStore([
    {
      id: 1,
      guildId: 'guild-1',
      channelId: 'channel-1',
      userId: 'user-1',
      itemName: 'Xanax',
      country: 'Japan',
      mode: 'available',
      flightType: 'airstrip',
      capacity: 29,
      status: 'active'
    }
  ]);
  const service = new AlertService({
    discordClient: createDiscordClient(sentMessages),
    droqsdbClient: createPreviewClient({
      preview: {
        mode: 'available',
        shouldNotifyNow: true,
        itemName: 'Xanax',
        country: 'Japan',
        currentStock: 1234,
        buyPrice: 786000,
        totalRunCost: 22794000,
        flightType: 'airstrip',
        capacity: 29,
        flightLengthLabel: '2h 38m',
        restockWindow: { label: '14:00-15:40 TCT' },
        confidence: 'medium',
        snapshotFreshness: 'fresh',
        predictionReason: 'Stock is currently available.'
      }
    }),
    alertStore: store,
    logger: createSilentLogger()
  });

  await service.runOnce();
  await service.runOnce();

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].userId, 'user-1');
  assert.match(sentMessages[0].payload.content, /DroqsDB Stock Alert/);
  assert.match(sentMessages[0].payload.content, /Stock: 1,234/);
  assert.match(sentMessages[0].payload.content, /Buy price: \$786,000/);
  assert.match(sentMessages[0].payload.content, /Estimated run cost: \$22,794,000/);
  assert.match(sentMessages[0].payload.content, /Flight: Airstrip, ~2h 38m/);
  assert.match(sentMessages[0].payload.content, /Capacity: 29/);
  assert.match(sentMessages[0].payload.content, /Restock window: 14:00-15:40 TCT/);
  assert.match(sentMessages[0].payload.content, /Confidence: Medium/);
  assert.doesNotMatch(sentMessages[0].payload.content, /<@user-1>/);
  assert.equal(store.alerts[0].status, 'triggered');
});

test('AlertService recurring available alerts fire on false to true transitions', async () => {
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
      repeatMode: 'every_time',
      lastConditionState: false,
      status: 'active'
    }
  ]);
  const service = new AlertService({
    discordClient: createDiscordClient(sentMessages),
    droqsdbClient: createPreviewClient({
      previews: [
        { mode: 'available', shouldNotifyNow: true, itemName: 'Xanax', country: 'Mexico' },
        { mode: 'available', shouldNotifyNow: true, itemName: 'Xanax', country: 'Mexico' },
        { mode: 'available', shouldNotifyNow: false, itemName: 'Xanax', country: 'Mexico' },
        { mode: 'available', shouldNotifyNow: true, itemName: 'Xanax', country: 'Mexico' }
      ]
    }),
    alertStore: store,
    logger: createSilentLogger()
  });

  await service.runOnce();
  await service.runOnce();
  await service.runOnce();
  await service.runOnce();

  assert.equal(sentMessages.length, 2);
  assert.equal(store.alerts[0].status, 'active');
  assert.equal(store.alerts[0].triggeredAt, undefined);
  assert.equal(store.alerts[0].lastConditionState, true);
  assert.ok(store.alerts[0].lastNotifiedAt);
});

test('AlertService recurring fly-out alerts do not spam while true', async () => {
  const sentMessages = [];
  const store = createMemoryAlertStore([
    {
      id: 1,
      guildId: 'guild-1',
      channelId: 'channel-1',
      userId: 'user-1',
      itemName: 'Xanax',
      country: 'Mexico',
      mode: 'flyout',
      repeatMode: 'every_time',
      lastConditionState: false,
      status: 'active'
    }
  ]);
  const service = new AlertService({
    discordClient: createDiscordClient(sentMessages),
    droqsdbClient: createPreviewClient({
      preview: {
        mode: 'flyout',
        shouldNotifyNow: true,
        itemName: 'Xanax',
        country: 'Mexico',
        arrivalAtTct: '14:38 TCT'
      }
    }),
    alertStore: store,
    logger: createSilentLogger()
  });

  await service.runOnce();
  await service.runOnce();

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].payload.content, /DroqsDB Fly-out Alert/);
  assert.match(sentMessages[0].payload.content, /Leave now/);
  assert.equal(store.alerts[0].status, 'active');
  assert.equal(store.alerts[0].lastConditionState, true);
});

test('AlertService API failure preserves recurring condition state', async () => {
  const store = createMemoryAlertStore([
    {
      id: 1,
      guildId: 'guild-1',
      channelId: 'channel-1',
      userId: 'user-1',
      itemName: 'Xanax',
      country: 'Mexico',
      mode: 'available',
      repeatMode: 'every_time',
      lastConditionState: false,
      status: 'active'
    }
  ]);
  const service = new AlertService({
    discordClient: createDiscordClient([]),
    droqsdbClient: createPreviewClient({
      previews: [new Error('API down')]
    }),
    alertStore: store,
    logger: createSilentLogger()
  });

  await service.runOnce();

  assert.equal(store.alerts[0].status, 'active');
  assert.equal(store.alerts[0].triggeredAt, undefined);
  assert.equal(store.alerts[0].lastConditionState, false);
  assert.equal(store.alerts[0].lastCheckedAt, undefined);
});

test('AlertService calls alert preview with stored personalization and caches identical requests', async () => {
  const sentMessages = [];
  const capturedQueries = [];
  const store = createMemoryAlertStore([
    {
      id: 1,
      guildId: 'guild-1',
      channelId: 'channel-1',
      userId: 'user-1',
      itemName: 'Xanax',
      country: 'Japan',
      mode: 'flyout',
      flightType: 'airstrip',
      capacity: 29,
      sellTarget: 'bazaar',
      marketTax: false,
      status: 'active'
    },
    {
      id: 2,
      guildId: 'guild-1',
      channelId: 'channel-1',
      userId: 'user-2',
      itemName: 'Xanax',
      country: 'Japan',
      mode: 'flyout',
      flightType: 'airstrip',
      capacity: 29,
      sellTarget: 'bazaar',
      marketTax: false,
      status: 'active'
    }
  ]);
  const service = new AlertService({
    discordClient: createDiscordClient(sentMessages),
    droqsdbClient: createPreviewClient({
      preview: {
        mode: 'flyout',
        shouldNotifyNow: true,
        itemName: 'Xanax',
        country: 'Japan'
      },
      onQuery(query) {
        capturedQueries.push(query);
      }
    }),
    alertStore: store,
    logger: createSilentLogger()
  });

  await service.runOnce();

  assert.equal(capturedQueries.length, 1);
  assert.deepEqual(capturedQueries[0], {
    item: 'Xanax',
    country: 'Japan',
    mode: 'flyout',
    flightType: 'airstrip',
    capacity: 29,
    sellTarget: 'bazaar',
    marketTax: false
  });
  assert.equal(sentMessages.length, 2);
});

test('AlertService DM failure disables without posting public details', async () => {
  const sentMessages = [];
  const channelFetches = [];
  const logs = [];
  const store = createMemoryAlertStore([
    {
      id: 1,
      guildId: 'guild-1',
      channelId: 'channel-1',
      userId: 'user-1',
      itemName: 'Xanax',
      country: 'Japan',
      mode: 'flyout',
      status: 'active'
    }
  ]);
  const service = new AlertService({
    discordClient: createDiscordClient(sentMessages, {
      failDm: true,
      channelFetches
    }),
    droqsdbClient: createPreviewClient({
      preview: {
        mode: 'flyout',
        shouldNotifyNow: true,
        itemName: 'Xanax',
        country: 'Japan'
      }
    }),
    alertStore: store,
    logger: createCapturingLogger(logs)
  });

  await service.runOnce();

  assert.equal(sentMessages.length, 0);
  assert.equal(channelFetches.length, 0);
  assert.equal(store.alerts[0].status, 'disabled');
  assert.equal(store.alerts[0].disabledReason, 'dm_failed');
  assert.ok(logs.some((entry) => entry.message === 'alerts.dm_send_failed'));
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
    markAlertConditionState({
      id,
      conditionState,
      checkedAt = new Date().toISOString(),
      conditionChangedAt = null
    }) {
      const alert = this.alerts.find((entry) => entry.id === id);
      alert.lastCheckedAt = checkedAt;
      alert.lastConditionState = conditionState;

      if (conditionChangedAt) {
        alert.lastConditionChangedAt = conditionChangedAt;
      }
    },
    markAlertNotified({
      id,
      notifiedAt = new Date().toISOString()
    }) {
      const alert = this.alerts.find((entry) => entry.id === id);
      alert.lastNotifiedAt = notifiedAt;
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

function createPreviewClient({
  preview = null,
  previews = null,
  onQuery = null
} = {}) {
  const queue = Array.isArray(previews) ? [...previews] : [preview];

  return {
    getBotAlertPreviewSettings(overrides = {}) {
      return {
        flightType: overrides.flightType || 'private',
        capacity: overrides.capacity ?? 19,
        sellTarget: overrides.sellTarget || 'market',
        marketTax: typeof overrides.marketTax === 'boolean' ? overrides.marketTax : true
      };
    },
    async queryAlertPreview(query) {
      onQuery?.(query);
      const next = queue.length > 1 ? queue.shift() : queue[0];

      if (next instanceof Error) {
        throw next;
      }

      return {
        ok: true,
        ...next
      };
    }
  };
}

function createDiscordClient(sentMessages, {
  failDm = false,
  failUserFetch = false,
  channelFetches = []
} = {}) {
  return {
    users: {
      async fetch(userId) {
        if (failUserFetch) {
          throw new Error('User fetch failed');
        }

        return {
          async send(payload) {
            if (failDm) {
              throw new Error('DM blocked');
            }

            sentMessages.push({
              userId,
              payload
            });
          }
        };
      }
    },
    channels: {
      async fetch(channelId) {
        channelFetches.push(channelId);
        throw new Error('Public channel should not be used for alert delivery.');
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

function createCapturingLogger(entries) {
  return {
    info(message, ...args) {
      entries.push({ level: 'info', message, args });
    },
    warn(message, ...args) {
      entries.push({ level: 'warn', message, args });
    },
    error(message, ...args) {
      entries.push({ level: 'error', message, args });
    }
  };
}
