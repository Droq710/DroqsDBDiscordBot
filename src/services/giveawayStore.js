const fs = require('node:fs/promises');
const path = require('node:path');
const Database = require('better-sqlite3');
const {
  DEFAULT_GIVEAWAY_WINNER_COOLDOWN_MS,
  ENTRY_MODE_PLACEHOLDER_END_AT,
  GIVEAWAY_END_MODE_TIME,
  normalizeGiveawayEndMode,
  normalizeGiveawayGameType,
  normalizeGiveawayMaxEntries,
  normalizeGiveawayWinnerCooldownEnabled,
  normalizeGiveawayWinnerCooldownMs
} = require('../utils/giveaway');

class GiveawayStore {
  constructor({
    databasePath,
    logger = console
  }) {
    this.databasePath = databasePath;
    this.logger = logger;
    this.db = null;
    this.statements = null;
  }

  async initialize() {
    if (this.db) {
      return;
    }

    await fs.mkdir(path.dirname(this.databasePath), { recursive: true });

    this.db = new Database(this.databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS giveaways (
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
        end_mode TEXT NOT NULL DEFAULT 'time',
        game_type TEXT NOT NULL DEFAULT 'standard',
        max_entries INTEGER,
        winner_cooldown_enabled INTEGER NOT NULL DEFAULT 0,
        winner_cooldown_ms INTEGER NOT NULL DEFAULT 180000,
        blocked_entry_user_ids_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        ended_at TEXT,
        rerolled_at TEXT,
        rerolled_by TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS giveaway_winner_cooldowns (
        user_id TEXT PRIMARY KEY,
        cooldown_ends_at TEXT NOT NULL,
        giveaway_message_id TEXT,
        guild_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_giveaways_status_end_at
      ON giveaways (status, end_at);

      CREATE INDEX IF NOT EXISTS idx_giveaways_guild_status
      ON giveaways (guild_id, status);

      CREATE INDEX IF NOT EXISTS idx_giveaway_winner_cooldowns_end_at
      ON giveaway_winner_cooldowns (cooldown_ends_at);
    `);

    this.ensureGiveawaySchema();
    this.prepareStatements();
    this.pruneExpiredWinnerCooldowns();
    this.logger.info('giveaway_store.initialized', {
      databasePath: this.databasePath
    });
  }

  close() {
    if (!this.db) {
      return;
    }

    this.db.close();
    this.db = null;
    this.statements = null;
    this.logger.info('giveaway_store.closed', {
      databasePath: this.databasePath
    });
  }

  createGiveaway({
    guildId,
    channelId,
    messageId,
    hostId,
    prizeText,
    winnerCount,
    durationMs,
    endAt,
    endMode = GIVEAWAY_END_MODE_TIME,
    gameType = 'standard',
    maxEntries = null,
    winnerCooldownEnabled = false,
    winnerCooldownMs = DEFAULT_GIVEAWAY_WINNER_COOLDOWN_MS
  }) {
    const now = new Date().toISOString();
    const normalizedEndMode = normalizeGiveawayEndMode(endMode);

    this.requireStatements().insertGiveaway.run({
      guildId: String(guildId),
      channelId: String(channelId),
      messageId: String(messageId),
      hostId: String(hostId),
      prizeText: String(prizeText),
      winnerCount: Math.max(1, Math.floor(Number(winnerCount) || 1)),
      durationMs: Math.max(0, Math.floor(Number(durationMs) || 0)),
      endAt:
        normalizedEndMode === GIVEAWAY_END_MODE_TIME
          ? String(endAt)
          : ENTRY_MODE_PLACEHOLDER_END_AT,
      endMode: normalizedEndMode,
      gameType: normalizeGiveawayGameType(gameType),
      maxEntries: normalizeGiveawayMaxEntries(maxEntries),
      winnerCooldownEnabled: normalizeGiveawayWinnerCooldownEnabled(winnerCooldownEnabled) ? 1 : 0,
      winnerCooldownMs: normalizeGiveawayWinnerCooldownMs(winnerCooldownMs),
      createdAt: now,
      updatedAt: now
    });

    return this.getGiveawayByMessageId(messageId);
  }

  deleteGiveaway(messageId) {
    this.requireStatements().deleteGiveaway.run(String(messageId));
  }

  getGiveawayByMessageId(messageId) {
    const row = this.requireStatements().selectByMessageId.get(String(messageId));
    return row ? mapGiveawayRow(row) : null;
  }

  listPendingGiveaways() {
    return this.requireStatements()
      .selectPending.all()
      .map(mapGiveawayRow);
  }

  transitionGiveawayStatus({
    messageId,
    fromStatus,
    toStatus
  }) {
    const result = this.requireStatements().updateStatus.run({
      messageId: String(messageId),
      fromStatus: String(fromStatus),
      toStatus: String(toStatus),
      updatedAt: new Date().toISOString()
    });

    return result.changes > 0;
  }

  markGiveawayEnded({
    messageId,
    entrantIds = [],
    winnerIds = [],
    endedAt = new Date().toISOString()
  }) {
    this.requireStatements().markEnded.run({
      messageId: String(messageId),
      entrantIdsJson: JSON.stringify(normalizeIdList(entrantIds)),
      winnerIdsJson: JSON.stringify(normalizeIdList(winnerIds)),
      endedAt,
      updatedAt: endedAt
    });

    return this.getGiveawayByMessageId(messageId);
  }

  updateGiveawayWinners({
    messageId,
    winnerIds = [],
    rerolledAt = new Date().toISOString(),
    rerolledBy = null
  }) {
    this.requireStatements().updateWinners.run({
      messageId: String(messageId),
      winnerIdsJson: JSON.stringify(normalizeIdList(winnerIds)),
      rerolledAt,
      rerolledBy: rerolledBy ? String(rerolledBy) : null,
      updatedAt: rerolledAt
    });

    return this.getGiveawayByMessageId(messageId);
  }

  updateGiveawayBlockedEntries({
    messageId,
    blockedEntryIds = [],
    updatedAt = new Date().toISOString()
  }) {
    this.requireStatements().updateBlockedEntries.run({
      messageId: String(messageId),
      blockedEntryIdsJson: JSON.stringify(normalizeIdList(blockedEntryIds)),
      updatedAt
    });

    return this.getGiveawayByMessageId(messageId);
  }

  getWinnerCooldownByUserId(userId, now = new Date().toISOString()) {
    this.pruneExpiredWinnerCooldowns(now);

    const row = this.requireStatements().selectWinnerCooldownByUserId.get(
      String(userId),
      now
    );

    return row ? mapWinnerCooldownRow(row) : null;
  }

  startWinnerCooldown({
    userId,
    giveawayMessageId = null,
    guildId = null,
    cooldownEndsAt,
    startedAt = new Date().toISOString()
  }) {
    this.pruneExpiredWinnerCooldowns(startedAt);

    this.requireStatements().upsertWinnerCooldown.run({
      userId: String(userId),
      cooldownEndsAt: String(cooldownEndsAt),
      giveawayMessageId: giveawayMessageId ? String(giveawayMessageId) : null,
      guildId: guildId ? String(guildId) : null,
      createdAt: startedAt,
      updatedAt: startedAt
    });

    return this.getWinnerCooldownByUserId(userId, startedAt);
  }

  pruneExpiredWinnerCooldowns(now = new Date().toISOString()) {
    if (!this.db) {
      return;
    }

    if (this.statements?.deleteExpiredWinnerCooldowns) {
      this.statements.deleteExpiredWinnerCooldowns.run(now);
      return;
    }

    this.db
      .prepare('DELETE FROM giveaway_winner_cooldowns WHERE cooldown_ends_at <= ?')
      .run(now);
  }

  prepareStatements() {
    this.statements = {
      insertGiveaway: this.db.prepare(`
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
          end_mode,
          game_type,
          max_entries,
          winner_cooldown_enabled,
          winner_cooldown_ms,
          blocked_entry_user_ids_json,
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
          'active',
          '[]',
          '[]',
          @endMode,
          @gameType,
          @maxEntries,
          @winnerCooldownEnabled,
          @winnerCooldownMs,
          '[]',
          @createdAt,
          @updatedAt
        )
      `),
      deleteGiveaway: this.db.prepare('DELETE FROM giveaways WHERE message_id = ?'),
      selectByMessageId: this.db.prepare(`
        SELECT
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
          end_mode,
          game_type,
          max_entries,
          winner_cooldown_enabled,
          winner_cooldown_ms,
          blocked_entry_user_ids_json,
          created_at,
          ended_at,
          rerolled_at,
          rerolled_by,
          updated_at
        FROM giveaways
        WHERE message_id = ?
      `),
      selectPending: this.db.prepare(`
        SELECT
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
          end_mode,
          game_type,
          max_entries,
          winner_cooldown_enabled,
          winner_cooldown_ms,
          blocked_entry_user_ids_json,
          created_at,
          ended_at,
          rerolled_at,
          rerolled_by,
          updated_at
        FROM giveaways
        WHERE status IN ('active', 'ending')
        ORDER BY end_at ASC, message_id ASC
      `),
      updateStatus: this.db.prepare(`
        UPDATE giveaways
        SET
          status = @toStatus,
          updated_at = @updatedAt
        WHERE message_id = @messageId
          AND status = @fromStatus
      `),
      markEnded: this.db.prepare(`
        UPDATE giveaways
        SET
          status = 'ended',
          entrant_ids_json = @entrantIdsJson,
          winner_ids_json = @winnerIdsJson,
          ended_at = @endedAt,
          updated_at = @updatedAt
        WHERE message_id = @messageId
      `),
      updateWinners: this.db.prepare(`
        UPDATE giveaways
        SET
          winner_ids_json = @winnerIdsJson,
          rerolled_at = @rerolledAt,
          rerolled_by = @rerolledBy,
          updated_at = @updatedAt
        WHERE message_id = @messageId
          AND status = 'ended'
      `),
      updateBlockedEntries: this.db.prepare(`
        UPDATE giveaways
        SET
          blocked_entry_user_ids_json = @blockedEntryIdsJson,
          updated_at = @updatedAt
        WHERE message_id = @messageId
      `),
      selectWinnerCooldownByUserId: this.db.prepare(`
        SELECT
          user_id,
          cooldown_ends_at,
          giveaway_message_id,
          guild_id,
          created_at,
          updated_at
        FROM giveaway_winner_cooldowns
        WHERE user_id = ?
          AND cooldown_ends_at > ?
      `),
      upsertWinnerCooldown: this.db.prepare(`
        INSERT INTO giveaway_winner_cooldowns (
          user_id,
          cooldown_ends_at,
          giveaway_message_id,
          guild_id,
          created_at,
          updated_at
        ) VALUES (
          @userId,
          @cooldownEndsAt,
          @giveawayMessageId,
          @guildId,
          @createdAt,
          @updatedAt
        )
        ON CONFLICT(user_id) DO UPDATE SET
          cooldown_ends_at = CASE
            WHEN excluded.cooldown_ends_at > giveaway_winner_cooldowns.cooldown_ends_at
              THEN excluded.cooldown_ends_at
            ELSE giveaway_winner_cooldowns.cooldown_ends_at
          END,
          giveaway_message_id = CASE
            WHEN excluded.cooldown_ends_at > giveaway_winner_cooldowns.cooldown_ends_at
              THEN excluded.giveaway_message_id
            ELSE giveaway_winner_cooldowns.giveaway_message_id
          END,
          guild_id = CASE
            WHEN excluded.cooldown_ends_at > giveaway_winner_cooldowns.cooldown_ends_at
              THEN excluded.guild_id
            ELSE giveaway_winner_cooldowns.guild_id
          END,
          updated_at = CASE
            WHEN excluded.cooldown_ends_at > giveaway_winner_cooldowns.cooldown_ends_at
              THEN excluded.updated_at
            ELSE giveaway_winner_cooldowns.updated_at
          END
      `),
      deleteExpiredWinnerCooldowns: this.db.prepare(`
        DELETE FROM giveaway_winner_cooldowns
        WHERE cooldown_ends_at <= ?
      `)
    };
  }

  ensureGiveawaySchema() {
    const columns = new Set(
      this.db.prepare('PRAGMA table_info(giveaways)').all().map((row) => row.name)
    );

    if (!columns.has('end_mode')) {
      this.db.exec(`
        ALTER TABLE giveaways
        ADD COLUMN end_mode TEXT NOT NULL DEFAULT 'time'
      `);
    }

    if (!columns.has('max_entries')) {
      this.db.exec(`
        ALTER TABLE giveaways
        ADD COLUMN max_entries INTEGER
      `);
    }

    if (!columns.has('game_type')) {
      this.db.exec(`
        ALTER TABLE giveaways
        ADD COLUMN game_type TEXT NOT NULL DEFAULT 'standard'
      `);
    }

    if (!columns.has('winner_cooldown_enabled')) {
      this.db.exec(`
        ALTER TABLE giveaways
        ADD COLUMN winner_cooldown_enabled INTEGER NOT NULL DEFAULT 0
      `);
    }

    if (!columns.has('winner_cooldown_ms')) {
      this.db.exec(`
        ALTER TABLE giveaways
        ADD COLUMN winner_cooldown_ms INTEGER NOT NULL DEFAULT ${DEFAULT_GIVEAWAY_WINNER_COOLDOWN_MS}
      `);
    }

    if (!columns.has('blocked_entry_user_ids_json')) {
      this.db.exec(`
        ALTER TABLE giveaways
        ADD COLUMN blocked_entry_user_ids_json TEXT NOT NULL DEFAULT '[]'
      `);
    }
  }

  requireStatements() {
    if (!this.statements) {
      throw new Error('GiveawayStore has not been initialized yet.');
    }

    return this.statements;
  }
}

function mapGiveawayRow(row) {
  const endMode = normalizeGiveawayEndMode(row.end_mode);

  return {
    messageId: row.message_id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    hostId: row.host_id,
    prizeText: row.prize_text,
    winnerCount: Math.max(1, Math.floor(Number(row.winner_count) || 1)),
    durationMs: Math.max(0, Math.floor(Number(row.duration_ms) || 0)),
    endAt:
      endMode === GIVEAWAY_END_MODE_TIME || row.end_at !== ENTRY_MODE_PLACEHOLDER_END_AT
        ? row.end_at
        : null,
    endMode,
    gameType: normalizeGiveawayGameType(row.game_type),
    maxEntries: normalizeGiveawayMaxEntries(row.max_entries),
    winnerCooldownEnabled: normalizeGiveawayWinnerCooldownEnabled(
      row.winner_cooldown_enabled
    ),
    winnerCooldownMs: normalizeGiveawayWinnerCooldownMs(row.winner_cooldown_ms),
    status: row.status || 'active',
    entrantIds: parseJsonIdList(row.entrant_ids_json),
    winnerIds: parseJsonIdList(row.winner_ids_json),
    blockedEntryIds: parseJsonIdList(row.blocked_entry_user_ids_json),
    createdAt: row.created_at || null,
    endedAt: row.ended_at || null,
    rerolledAt: row.rerolled_at || null,
    rerolledBy: row.rerolled_by || null,
    updatedAt: row.updated_at || null
  };
}

function mapWinnerCooldownRow(row) {
  return {
    userId: row.user_id,
    cooldownEndsAt: row.cooldown_ends_at,
    giveawayMessageId: row.giveaway_message_id || null,
    guildId: row.guild_id || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  };
}

function parseJsonIdList(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return normalizeIdList(parsed);
  } catch (error) {
    return [];
  }
}

function normalizeIdList(value) {
  return Array.from(
    new Set(
      Array.isArray(value)
        ? value
            .map((entry) => String(entry || '').trim())
            .filter(Boolean)
        : []
    )
  );
}

module.exports = {
  GiveawayStore
};
