const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const { GiveawayStore } = require('../src/services/giveawayStore');
const {
  DEFAULT_GIVEAWAY_WINNER_COOLDOWN_MS,
  GIVEAWAY_END_MODE_TIME,
  GIVEAWAY_GAME_TYPE_STANDARD
} = require('../src/utils/giveaway');

const TEST_TMP_ROOT = path.join(__dirname, '.tmp');

test('GiveawayStore applies safe defaults to legacy giveaway rows', async (t) => {
  const tempDir = path.join(
    TEST_TMP_ROOT,
    `giveaway-store-legacy-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  const dbPath = path.join(tempDir, 'giveaways.sqlite');

  await fs.mkdir(tempDir, { recursive: true });

  const legacyDb = new Database(dbPath);
  legacyDb.exec(`
    CREATE TABLE giveaways (
      message_id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      host_id TEXT NOT NULL,
      prize_text TEXT NOT NULL,
      winner_count INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      end_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      entrant_ids_json TEXT NOT NULL DEFAULT '[]',
      winner_ids_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      ended_at TEXT,
      rerolled_at TEXT,
      rerolled_by TEXT,
      updated_at TEXT NOT NULL
    );
  `);
  legacyDb.prepare(`
    INSERT INTO giveaways (
      message_id,
      guild_id,
      channel_id,
      host_id,
      prize_text,
      winner_count,
      duration_ms,
      end_at,
      status,
      entrant_ids_json,
      winner_ids_json,
      created_at,
      updated_at
    ) VALUES (
      @messageId,
      @guildId,
      @channelId,
      @hostId,
      @prizeText,
      @winnerCount,
      @durationMs,
      @endAt,
      @status,
      @entrantIdsJson,
      @winnerIdsJson,
      @createdAt,
      @updatedAt
    )
  `).run({
    messageId: '1234567890',
    guildId: 'guild-1',
    channelId: 'channel-1',
    hostId: 'host-1',
    prizeText: 'Rare Plushie',
    winnerCount: 2,
    durationMs: 15 * 60 * 1000,
    endAt: '2026-04-02T12:15:00.000Z',
    status: 'active',
    entrantIdsJson: '[]',
    winnerIdsJson: '[]',
    createdAt: '2026-04-02T12:00:00.000Z',
    updatedAt: '2026-04-02T12:00:00.000Z'
  });
  legacyDb.close();

  const store = new GiveawayStore({
    databasePath: dbPath,
    logger: createSilentLogger()
  });
  await store.initialize();
  t.after(async () => {
    store.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const giveaway = store.getGiveawayByMessageId('1234567890');

  assert.equal(giveaway.endMode, GIVEAWAY_END_MODE_TIME);
  assert.equal(giveaway.gameType, GIVEAWAY_GAME_TYPE_STANDARD);
  assert.equal(giveaway.maxEntries, null);
  assert.equal(giveaway.winnerCooldownEnabled, false);
  assert.equal(giveaway.winnerCooldownMs, DEFAULT_GIVEAWAY_WINNER_COOLDOWN_MS);
  assert.deepEqual(giveaway.blockedEntryIds, []);
});

test('GiveawayStore persists winner cooldowns and keeps the latest expiry', async (t) => {
  const tempDir = path.join(
    TEST_TMP_ROOT,
    `giveaway-store-cooldown-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  const dbPath = path.join(tempDir, 'giveaways.sqlite');

  await fs.mkdir(tempDir, { recursive: true });

  const store = new GiveawayStore({
    databasePath: dbPath,
    logger: createSilentLogger()
  });
  await store.initialize();
  t.after(async () => {
    store.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  store.startWinnerCooldown({
    userId: 'winner-1',
    giveawayMessageId: 'message-1',
    guildId: 'guild-1',
    cooldownEndsAt: '2026-04-02T12:03:00.000Z',
    startedAt: '2026-04-02T12:00:00.000Z'
  });
  store.startWinnerCooldown({
    userId: 'winner-1',
    giveawayMessageId: 'message-2',
    guildId: 'guild-1',
    cooldownEndsAt: '2026-04-02T12:02:00.000Z',
    startedAt: '2026-04-02T12:01:00.000Z'
  });

  const activeCooldown = store.getWinnerCooldownByUserId(
    'winner-1',
    '2026-04-02T12:01:30.000Z'
  );

  assert.equal(activeCooldown.cooldownEndsAt, '2026-04-02T12:03:00.000Z');
  assert.equal(activeCooldown.giveawayMessageId, 'message-1');

  store.pruneExpiredWinnerCooldowns('2026-04-02T12:04:00.000Z');

  assert.equal(
    store.getWinnerCooldownByUserId('winner-1', '2026-04-02T12:04:00.000Z'),
    null
  );
});

function createSilentLogger() {
  return {
    info() {},
    warn() {},
    error() {}
  };
}
