const fs = require('node:fs/promises');
const path = require('node:path');
const Database = require('better-sqlite3');

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
        created_at TEXT NOT NULL,
        ended_at TEXT,
        rerolled_at TEXT,
        rerolled_by TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_giveaways_status_end_at
      ON giveaways (status, end_at);

      CREATE INDEX IF NOT EXISTS idx_giveaways_guild_status
      ON giveaways (guild_id, status);
    `);

    this.prepareStatements();
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
    endAt
  }) {
    const now = new Date().toISOString();

    this.requireStatements().insertGiveaway.run({
      guildId: String(guildId),
      channelId: String(channelId),
      messageId: String(messageId),
      hostId: String(hostId),
      prizeText: String(prizeText),
      winnerCount: Math.max(1, Math.floor(Number(winnerCount) || 1)),
      durationMs: Math.max(0, Math.floor(Number(durationMs) || 0)),
      endAt: String(endAt),
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
      `)
    };
  }

  requireStatements() {
    if (!this.statements) {
      throw new Error('GiveawayStore has not been initialized yet.');
    }

    return this.statements;
  }
}

function mapGiveawayRow(row) {
  return {
    messageId: row.message_id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    hostId: row.host_id,
    prizeText: row.prize_text,
    winnerCount: Math.max(1, Math.floor(Number(row.winner_count) || 1)),
    durationMs: Math.max(0, Math.floor(Number(row.duration_ms) || 0)),
    endAt: row.end_at,
    status: row.status || 'active',
    entrantIds: parseJsonIdList(row.entrant_ids_json),
    winnerIds: parseJsonIdList(row.winner_ids_json),
    createdAt: row.created_at || null,
    endedAt: row.ended_at || null,
    rerolledAt: row.rerolled_at || null,
    rerolledBy: row.rerolled_by || null,
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
