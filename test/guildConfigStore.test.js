const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const { GuildConfigStore } = require('../src/services/guildConfigStore');

function createLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {}
  };
}

test('guild config store migrates old autopost configs with daily forecast disabled defaults', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'droqbot-config-'));
  const databasePath = path.join(tempDir, 'autopost.sqlite');
  const db = new Database(databasePath);

  db.exec(`
    CREATE TABLE guild_autopost_configs (
      guild_id TEXT PRIMARY KEY,
      autopost_enabled INTEGER NOT NULL DEFAULT 0,
      channel_id TEXT,
      count INTEGER NOT NULL DEFAULT 10,
      preset_mode TEXT NOT NULL DEFAULT 'top_n',
      preset_country TEXT,
      preset_category TEXT,
      preset_countries TEXT NOT NULL DEFAULT '[]',
      preset_categories TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL,
      updated_by TEXT
    );
  `);
  db.prepare(`
    INSERT INTO guild_autopost_configs (
      guild_id,
      autopost_enabled,
      channel_id,
      count,
      preset_mode,
      preset_countries,
      preset_categories,
      updated_at,
      updated_by
    ) VALUES (
      'guild-1',
      1,
      'channel-1',
      5,
      'category_groups',
      '["Canada"]',
      '["drugs"]',
      '2026-04-01T00:00:00.000Z',
      'user-1'
    )
  `).run();
  db.close();

  const store = new GuildConfigStore({
    databasePath,
    logger: createLogger()
  });

  await store.initialize();
  const config = store.getGuildConfig('guild-1');

  assert.equal(config.autopostEnabled, true);
  assert.equal(config.channelId, 'channel-1');
  assert.equal(config.count, 5);
  assert.equal(config.dailyForecastEnabled, false);
  assert.equal(config.dailyForecastChannelId, null);
  assert.equal(config.dailyForecastTime, '08:00');
  assert.equal(config.dailyForecastCount, 10);
  assert.equal(config.dailyForecastLastPostDate, null);
  assert.deepEqual(store.listEnabledDailyForecastConfigs(), []);

  store.close();
  await fs.rm(tempDir, { recursive: true, force: true });
});
