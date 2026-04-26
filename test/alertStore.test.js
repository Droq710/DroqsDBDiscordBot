const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

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
  assert.equal(store.countActiveAlertsForUser('user-1'), 1);

  assert.deepEqual(
    store.listUserAlerts({
      guildId: 'guild-1',
      userId: 'user-1'
    }).map((entry) => ({
      id: entry.id,
      itemName: entry.itemName,
      country: entry.country,
      mode: entry.mode
    })),
    [
      {
        id: 1,
        itemName: 'Xanax',
        country: 'Mexico',
        mode: 'available'
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

function createSilentLogger() {
  return {
    info() {},
    warn() {},
    error() {}
  };
}
