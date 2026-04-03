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
    this.transactions = null;
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

      CREATE TABLE IF NOT EXISTS giveaway_leaderboard_wins (
        giveaway_message_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        stored_label TEXT,
        recorded_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (giveaway_message_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS giveaway_leaderboard_daily_posts (
        guild_id TEXT NOT NULL,
        post_date_utc TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'started',
        channel_id TEXT,
        message_id TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        failure_reason TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (guild_id, post_date_utc)
      );

      CREATE INDEX IF NOT EXISTS idx_giveaways_status_end_at
      ON giveaways (status, end_at);

      CREATE INDEX IF NOT EXISTS idx_giveaways_guild_status
      ON giveaways (guild_id, status);

      CREATE INDEX IF NOT EXISTS idx_giveaway_winner_cooldowns_end_at
      ON giveaway_winner_cooldowns (cooldown_ends_at);

      CREATE INDEX IF NOT EXISTS idx_giveaway_leaderboard_wins_guild_recorded_at
      ON giveaway_leaderboard_wins (guild_id, recorded_at);

      CREATE INDEX IF NOT EXISTS idx_giveaway_leaderboard_wins_guild_user
      ON giveaway_leaderboard_wins (guild_id, user_id);
    `);

    this.ensureGiveawaySchema();
    this.prepareStatements();
    this.backfillLeaderboardWins();
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
    this.transactions = null;
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

  listGiveawayLeaderboard(guildId, {
    limit = 10
  } = {}) {
    const normalizedGuildId = String(guildId || '').trim();

    if (!normalizedGuildId) {
      return [];
    }

    return this.requireStatements()
      .selectLeaderboardByGuild.all({
        guildId: normalizedGuildId,
        limit: normalizeLeaderboardLimit(limit)
      })
      .map(mapLeaderboardRow);
  }

  listGiveawayLeaderboardGuildIds() {
    return this.requireStatements()
      .selectLeaderboardGuildIds.all()
      .map((row) => String(row.guild_id || '').trim())
      .filter(Boolean);
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
    winnerSnapshots = [],
    endedAt = new Date().toISOString()
  }) {
    const normalizedMessageId = String(messageId);
    const normalizedWinnerIds = normalizeIdList(winnerIds);
    const leaderboardSync = this.requireTransactions().markGiveawayEnded({
      messageId: normalizedMessageId,
      entrantIdsJson: JSON.stringify(normalizeIdList(entrantIds)),
      winnerIdsJson: JSON.stringify(normalizedWinnerIds),
      endedAt,
      updatedAt: endedAt,
      winnerRecords: buildWinnerRecords(normalizedWinnerIds, winnerSnapshots)
    });

    return {
      giveaway: this.getGiveawayByMessageId(normalizedMessageId),
      leaderboardSync
    };
  }

  updateGiveawayWinners({
    messageId,
    winnerIds = [],
    winnerSnapshots = [],
    rerolledAt = new Date().toISOString(),
    rerolledBy = null
  }) {
    const normalizedMessageId = String(messageId);
    const normalizedWinnerIds = normalizeIdList(winnerIds);
    const leaderboardSync = this.requireTransactions().updateGiveawayWinners({
      messageId: normalizedMessageId,
      winnerIdsJson: JSON.stringify(normalizedWinnerIds),
      rerolledAt,
      rerolledBy: rerolledBy ? String(rerolledBy) : null,
      updatedAt: rerolledAt,
      winnerRecords: buildWinnerRecords(normalizedWinnerIds, winnerSnapshots)
    });

    return {
      giveaway: this.getGiveawayByMessageId(normalizedMessageId),
      leaderboardSync
    };
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

  tryBeginLeaderboardPost({
    guildId,
    postDateUtc,
    channelId = null,
    startedAt = new Date().toISOString()
  }) {
    const result = this.requireStatements().insertLeaderboardDailyPost.run({
      guildId: String(guildId),
      postDateUtc: String(postDateUtc),
      channelId: channelId ? String(channelId) : null,
      startedAt,
      updatedAt: startedAt
    });

    return result.changes > 0;
  }

  markLeaderboardPostCompleted({
    guildId,
    postDateUtc,
    channelId,
    messageId,
    completedAt = new Date().toISOString()
  }) {
    this.requireStatements().updateLeaderboardDailyPostCompleted.run({
      guildId: String(guildId),
      postDateUtc: String(postDateUtc),
      channelId: channelId ? String(channelId) : null,
      messageId: messageId ? String(messageId) : null,
      completedAt,
      updatedAt: completedAt
    });
  }

  markLeaderboardPostFailed({
    guildId,
    postDateUtc,
    channelId = null,
    failureReason = null,
    failedAt = new Date().toISOString()
  }) {
    this.requireStatements().updateLeaderboardDailyPostFailed.run({
      guildId: String(guildId),
      postDateUtc: String(postDateUtc),
      channelId: channelId ? String(channelId) : null,
      failureReason: normalizeFailureReason(failureReason),
      updatedAt: failedAt
    });
  }

  backfillLeaderboardWins() {
    const endedGiveaways = this.requireStatements().selectEndedGiveawaysForLeaderboardBackfill.all();

    if (!endedGiveaways.length) {
      return;
    }

    const synchronizedGiveawayCount = this.requireTransactions().backfillLeaderboardWins(
      endedGiveaways
    );

    this.logger.info('giveaway_store.leaderboard_backfilled', {
      synchronizedGiveawayCount
    });
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
      selectEndedGiveawaysForLeaderboardBackfill: this.db.prepare(`
        SELECT
          message_id,
          guild_id,
          winner_ids_json,
          created_at,
          ended_at,
          rerolled_at,
          updated_at
        FROM giveaways
        WHERE status = 'ended'
        ORDER BY updated_at ASC, message_id ASC
      `),
      selectGiveawayGuildByMessageId: this.db.prepare(`
        SELECT guild_id
        FROM giveaways
        WHERE message_id = ?
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
      `),
      selectLeaderboardWinsByGiveaway: this.db.prepare(`
        SELECT
          giveaway_message_id,
          guild_id,
          user_id,
          stored_label,
          recorded_at,
          updated_at
        FROM giveaway_leaderboard_wins
        WHERE giveaway_message_id = ?
        ORDER BY user_id ASC
      `),
      upsertLeaderboardWin: this.db.prepare(`
        INSERT INTO giveaway_leaderboard_wins (
          giveaway_message_id,
          guild_id,
          user_id,
          stored_label,
          recorded_at,
          updated_at
        ) VALUES (
          @giveawayMessageId,
          @guildId,
          @userId,
          @storedLabel,
          @recordedAt,
          @updatedAt
        )
        ON CONFLICT(giveaway_message_id, user_id) DO UPDATE SET
          guild_id = excluded.guild_id,
          stored_label = CASE
            WHEN excluded.stored_label IS NOT NULL AND TRIM(excluded.stored_label) <> ''
              THEN excluded.stored_label
            ELSE giveaway_leaderboard_wins.stored_label
          END,
          updated_at = excluded.updated_at
      `),
      deleteLeaderboardWin: this.db.prepare(`
        DELETE FROM giveaway_leaderboard_wins
        WHERE giveaway_message_id = ?
          AND user_id = ?
      `),
      selectLeaderboardByGuild: this.db.prepare(`
        SELECT
          wins.user_id,
          COUNT(*) AS win_count,
          MIN(wins.recorded_at) AS first_win_at,
          MAX(wins.updated_at) AS last_win_at,
          (
            SELECT inner_wins.stored_label
            FROM giveaway_leaderboard_wins inner_wins
            WHERE inner_wins.guild_id = wins.guild_id
              AND inner_wins.user_id = wins.user_id
              AND inner_wins.stored_label IS NOT NULL
              AND TRIM(inner_wins.stored_label) <> ''
            ORDER BY inner_wins.updated_at DESC, inner_wins.recorded_at DESC
            LIMIT 1
          ) AS stored_label
        FROM giveaway_leaderboard_wins wins
        WHERE wins.guild_id = @guildId
        GROUP BY wins.guild_id, wins.user_id
        ORDER BY win_count DESC, first_win_at ASC, wins.user_id ASC
        LIMIT @limit
      `),
      selectLeaderboardGuildIds: this.db.prepare(`
        SELECT DISTINCT guild_id
        FROM giveaway_leaderboard_wins
        ORDER BY guild_id ASC
      `),
      insertLeaderboardDailyPost: this.db.prepare(`
        INSERT INTO giveaway_leaderboard_daily_posts (
          guild_id,
          post_date_utc,
          status,
          channel_id,
          started_at,
          updated_at
        ) VALUES (
          @guildId,
          @postDateUtc,
          'started',
          @channelId,
          @startedAt,
          @updatedAt
        )
        ON CONFLICT(guild_id, post_date_utc) DO NOTHING
      `),
      updateLeaderboardDailyPostCompleted: this.db.prepare(`
        UPDATE giveaway_leaderboard_daily_posts
        SET
          status = 'completed',
          channel_id = @channelId,
          message_id = @messageId,
          completed_at = @completedAt,
          failure_reason = NULL,
          updated_at = @updatedAt
        WHERE guild_id = @guildId
          AND post_date_utc = @postDateUtc
      `),
      updateLeaderboardDailyPostFailed: this.db.prepare(`
        UPDATE giveaway_leaderboard_daily_posts
        SET
          status = 'failed',
          channel_id = COALESCE(@channelId, channel_id),
          failure_reason = @failureReason,
          updated_at = @updatedAt
        WHERE guild_id = @guildId
          AND post_date_utc = @postDateUtc
      `)
    };

    this.transactions = {
      markGiveawayEnded: this.db.transaction((payload) => {
        this.statements.markEnded.run(payload);

        return this.syncLeaderboardWinnerRecords({
          messageId: payload.messageId,
          guildId: this.lookupGiveawayGuildId(payload.messageId),
          winnerRecords: payload.winnerRecords,
          recordedAt: payload.endedAt
        });
      }),
      updateGiveawayWinners: this.db.transaction((payload) => {
        this.statements.updateWinners.run(payload);

        return this.syncLeaderboardWinnerRecords({
          messageId: payload.messageId,
          guildId: this.lookupGiveawayGuildId(payload.messageId),
          winnerRecords: payload.winnerRecords,
          recordedAt: payload.rerolledAt
        });
      }),
      backfillLeaderboardWins: this.db.transaction((endedGiveaways) => {
        for (const giveawayRow of endedGiveaways) {
          this.syncLeaderboardWinnerRecords({
            messageId: giveawayRow.message_id,
            guildId: giveawayRow.guild_id,
            winnerRecords: buildWinnerRecords(parseJsonIdList(giveawayRow.winner_ids_json)),
            recordedAt: resolveHistoricalLeaderboardRecordedAt(giveawayRow)
          });
        }

        return endedGiveaways.length;
      })
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

  syncLeaderboardWinnerRecords({
    messageId,
    guildId,
    winnerRecords = [],
    recordedAt = new Date().toISOString()
  }) {
    const normalizedMessageId = String(messageId || '').trim();
    const currentRows = this.statements.selectLeaderboardWinsByGiveaway.all(normalizedMessageId);
    const normalizedWinnerRecords = normalizeWinnerRecords(winnerRecords);
    const currentWinnerIdSet = new Set(currentRows.map((row) => row.user_id));
    const nextWinnerIdSet = new Set(normalizedWinnerRecords.map((row) => row.userId));
    const resolvedGuildId =
      String(guildId || '').trim() ||
      String(currentRows[0]?.guild_id || '').trim() ||
      null;

    for (const currentRow of currentRows) {
      if (!nextWinnerIdSet.has(currentRow.user_id)) {
        this.statements.deleteLeaderboardWin.run(normalizedMessageId, currentRow.user_id);
      }
    }

    for (const winnerRecord of normalizedWinnerRecords) {
      if (!resolvedGuildId) {
        continue;
      }

      this.statements.upsertLeaderboardWin.run({
        giveawayMessageId: normalizedMessageId,
        guildId: resolvedGuildId,
        userId: winnerRecord.userId,
        storedLabel: winnerRecord.storedLabel,
        recordedAt,
        updatedAt: recordedAt
      });
    }

    return {
      addedWinnerIds: normalizedWinnerRecords
        .filter((winnerRecord) => !currentWinnerIdSet.has(winnerRecord.userId))
        .map((winnerRecord) => winnerRecord.userId),
      removedWinnerIds: currentRows
        .filter((currentRow) => !nextWinnerIdSet.has(currentRow.user_id))
        .map((currentRow) => currentRow.user_id),
      winnerIds: normalizedWinnerRecords.map((winnerRecord) => winnerRecord.userId)
    };
  }

  lookupGiveawayGuildId(messageId) {
    return (
      this.statements.selectGiveawayGuildByMessageId.get(String(messageId || '').trim())?.guild_id ||
      null
    );
  }

  requireStatements() {
    if (!this.statements) {
      throw new Error('GiveawayStore has not been initialized yet.');
    }

    return this.statements;
  }

  requireTransactions() {
    if (!this.transactions) {
      throw new Error('GiveawayStore has not been initialized yet.');
    }

    return this.transactions;
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

function mapLeaderboardRow(row) {
  return {
    userId: row.user_id,
    winCount: Math.max(0, Math.floor(Number(row.win_count) || 0)),
    firstWinAt: row.first_win_at || null,
    lastWinAt: row.last_win_at || null,
    storedLabel: normalizeStoredLabel(row.stored_label)
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

function buildWinnerRecords(winnerIds, winnerSnapshots = []) {
  const storedLabelByUserId = new Map(
    (Array.isArray(winnerSnapshots) ? winnerSnapshots : [])
      .map((entry) => {
        const userId = String(entry?.userId || '').trim();

        if (!userId) {
          return null;
        }

        return [
          userId,
          normalizeStoredLabel(entry?.storedLabel || entry?.label || entry?.displayLabel || null)
        ];
      })
      .filter(Boolean)
  );

  return normalizeIdList(winnerIds).map((userId) => ({
    userId,
    storedLabel: storedLabelByUserId.get(userId) || null
  }));
}

function normalizeWinnerRecords(value) {
  const seen = new Set();
  const normalizedRecords = [];

  for (const entry of Array.isArray(value) ? value : []) {
    const userId =
      typeof entry === 'string'
        ? String(entry).trim()
        : String(entry?.userId || '').trim();

    if (!userId || seen.has(userId)) {
      continue;
    }

    seen.add(userId);
    normalizedRecords.push({
      userId,
      storedLabel:
        typeof entry === 'string' ? null : normalizeStoredLabel(entry?.storedLabel || null)
    });
  }

  return normalizedRecords;
}

function normalizeStoredLabel(value) {
  const normalized = String(value || '').trim();
  return normalized ? normalized.slice(0, 120) : null;
}

function normalizeFailureReason(value) {
  const normalized = String(value || '').trim();
  return normalized ? normalized.slice(0, 500) : null;
}

function normalizeLeaderboardLimit(value) {
  const numeric = Math.floor(Number(value) || 10);
  return Math.min(100, Math.max(1, numeric));
}

function resolveHistoricalLeaderboardRecordedAt(row) {
  const candidates = [row?.rerolled_at, row?.ended_at, row?.updated_at, row?.created_at];

  for (const candidate of candidates) {
    if (isValidIsoTimestamp(candidate)) {
      return candidate;
    }
  }

  return new Date().toISOString();
}

function isValidIsoTimestamp(value) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp);
}

module.exports = {
  GiveawayStore
};
