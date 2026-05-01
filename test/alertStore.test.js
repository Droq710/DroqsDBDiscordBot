const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const { AlertStore } = require('../src/services/alertStore');

const TEST_TMP_ROOT = path.join(__dirname, '.tmp');

test('AlertStore creates, lists, and removes user alerts', async (t) => {
  const tempDir = path.join(
    TEST_TMP_ROOT,
    `alert-store-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  const dbPath = path.join(tempDir, 'alerts.sqlite');

  await fs.mkdir(tempDir, { recursive: true });

  const store = new AlertStore({
    databasePath: dbPath,
    logger: createSilentLogger()
  });
  await store.initialize();
  t.after(async () => {
    store.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const alert = store.createAlert({
    guildId: 'guild-1',
    channelId: 'channel-1',
    userId: 'user-1',
    itemName: 'Xanax',
    country: 'Mexico',
    mode: 'available'
  });

  assert.equal(alert.id, 1);
  assert.equal(alert.status, 'active');
  assert.equal(alert.repeatMode, 'once');
  assert.equal(store.countActiveAlertsForUser('user-1'), 1);

  assert.deepEqual(
    store.listUserAlerts({
      guildId: 'guild-1',
      userId: 'user-1'
    }).map((entry) => ({
      id: entry.id,
      itemName: entry.itemName,
      country: entry.country,
      mode: entry.mode,
      repeatMode: entry.repeatMode
    })),
    [
      {
        id: 1,
        itemName: 'Xanax',
        country: 'Mexico',
        mode: 'available',
        repeatMode: 'once'
      }
    ]
  );

  assert.equal(
    store.disableAlertForUser({
      id: alert.id,
      guildId: 'guild-1',
      userId: 'user-1'
    }),
    true
  );
  assert.equal(store.countActiveAlertsForUser('user-1'), 0);
});

test('AlertStore stores recurring alert state', async (t) => {
  const tempDir = path.join(
    TEST_TMP_ROOT,
    `alert-store-recurring-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  const dbPath = path.join(tempDir, 'alerts.sqlite');

  await fs.mkdir(tempDir, { recursive: true });

  const store = new AlertStore({
    databasePath: dbPath,
    logger: createSilentLogger()
  });
  await store.initialize();
  t.after(async () => {
    store.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const alert = store.createAlert({
    guildId: 'guild-1',
    channelId: 'channel-1',
    userId: 'user-1',
    itemName: 'Xanax',
    country: 'Mexico',
    mode: 'available',
    repeatMode: 'every_time',
    lastConditionState: false
  });

  assert.equal(alert.repeatMode, 'every_time');
  assert.equal(alert.lastConditionState, false);
  assert.ok(alert.lastConditionChangedAt);

  store.markAlertConditionState({
    id: alert.id,
    conditionState: true,
    checkedAt: '2026-04-27T12:00:00.000Z',
    conditionChangedAt: '2026-04-27T12:00:00.000Z'
  });
  store.markAlertNotified({
    id: alert.id,
    notifiedAt: '2026-04-27T12:00:01.000Z'
  });

  const updated = store.getAlertById(alert.id);

  assert.equal(updated.status, 'active');
  assert.equal(updated.triggeredAt, null);
  assert.equal(updated.lastConditionState, true);
  assert.equal(updated.lastConditionChangedAt, '2026-04-27T12:00:00.000Z');
  assert.equal(updated.lastNotifiedAt, '2026-04-27T12:00:01.000Z');
});

test('AlertStore stores alert personalization fields', async (t) => {
  const tempDir = path.join(
    TEST_TMP_ROOT,
    `alert-store-personalization-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  const dbPath = path.join(tempDir, 'alerts.sqlite');

  await fs.mkdir(tempDir, { recursive: true });

  const store = new AlertStore({
    databasePath: dbPath,
    logger: createSilentLogger()
  });
  await store.initialize();
  t.after(async () => {
    store.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const alert = store.createAlert({
    guildId: 'guild-1',
    channelId: 'channel-1',
    userId: 'user-1',
    itemName: 'Xanax',
    country: 'Japan',
    mode: 'flyout',
    repeatMode: 'every_time',
    flightType: 'airstrip',
    capacity: 29,
    sellTarget: 'bazaar',
    marketTax: false
  });
  const stored = store.getAlertById(alert.id);

  assert.equal(stored.flightType, 'airstrip');
  assert.equal(stored.capacity, 29);
  assert.equal(stored.sellTarget, 'bazaar');
  assert.equal(stored.marketTax, false);
});

test('AlertStore migrates existing alerts as one-time alerts', async (t) => {
  const tempDir = path.join(
    TEST_TMP_ROOT,
    `alert-store-migration-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  const dbPath = path.join(tempDir, 'alerts.sqlite');

  await fs.mkdir(tempDir, { recursive: true });

  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      item_name TEXT NOT NULL,
      country TEXT NOT NULL,
      mode TEXT NOT NULL,
      note TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      disabled_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_checked_at TEXT,
      last_notified_at TEXT,
      triggered_at TEXT
    );
    INSERT INTO alerts (
      guild_id,
      channel_id,
      user_id,
      item_name,
      country,
      mode,
      status,
      created_at,
      updated_at
    ) VALUES (
      'guild-1',
      'channel-1',
      'user-1',
      'Xanax',
      'Mexico',
      'available',
      'active',
      '2026-04-27T00:00:00.000Z',
      '2026-04-27T00:00:00.000Z'
    );
  `);
  db.close();

  const store = new AlertStore({
    databasePath: dbPath,
    logger: createSilentLogger()
  });
  await store.initialize();
  t.after(async () => {
    store.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const alert = store.getAlertById(1);

  assert.equal(alert.repeatMode, 'once');
  assert.equal(alert.flightType, null);
  assert.equal(alert.capacity, null);
  assert.equal(alert.sellTarget, null);
  assert.equal(alert.marketTax, null);
  assert.equal(alert.lastConditionState, null);
  assert.equal(alert.lastConditionChangedAt, null);
});

function createSilentLogger() {
  return {
    info() {},
    warn() {},
    error() {}
  };
}
