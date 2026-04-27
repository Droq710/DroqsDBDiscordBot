const fs = require('node:fs/promises');
const path = require('node:path');
const Database = require('better-sqlite3');

const ALERT_MODE_AVAILABLE = 'available';
const ALERT_MODE_FLYOUT = 'flyout';
const ALERT_REPEAT_ONCE = 'once';
const ALERT_REPEAT_EVERY_TIME = 'every_time';
const ALERT_STATUS_ACTIVE = 'active';
const ALERT_STATUS_TRIGGERED = 'triggered';
const ALERT_STATUS_DISABLED = 'disabled';
const ALERT_CONDITION_STATE_TRUE = 'true';
const ALERT_CONDITION_STATE_FALSE = 'false';
const DEFAULT_MAX_ACTIVE_ALERTS_PER_USER = 10;

class AlertStore {
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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        item_name TEXT NOT NULL,
        country TEXT NOT NULL,
        mode TEXT NOT NULL,
        flight_type TEXT,
        capacity INTEGER,
        note TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        repeat_mode TEXT NOT NULL DEFAULT 'once',
        disabled_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_checked_at TEXT,
        last_condition_state TEXT,
        last_condition_changed_at TEXT,
        last_notified_at TEXT,
        triggered_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_alerts_active_user
      ON alerts (user_id, status, triggered_at);

      CREATE INDEX IF NOT EXISTS idx_alerts_status_updated
      ON alerts (status, updated_at);
    `);

    this.ensureAlertSchema();
    this.prepareStatements();
    this.logger.info('alert_store.initialized', {
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
    this.logger.info('alert_store.closed', {
      databasePath: this.databasePath
    });
  }

  createAlert({
    guildId,
    channelId,
    userId,
    itemName,
    country,
    mode,
    repeatMode = ALERT_REPEAT_ONCE,
    flightType = null,
    capacity = null,
    note = null,
    lastConditionState = null,
    lastConditionChangedAt = null
  }) {
    const now = new Date().toISOString();
    const normalizedLastConditionState = normalizeAlertConditionState(lastConditionState);
    const result = this.requireStatements().insertAlert.run({
      guildId: String(guildId),
      channelId: String(channelId),
      userId: String(userId),
      itemName: String(itemName),
      country: String(country),
      mode: normalizeAlertMode(mode),
      repeatMode: normalizeAlertRepeatMode(repeatMode),
      flightType: normalizeFlightType(flightType),
      capacity: normalizeCapacity(capacity),
      note: normalizeNote(note),
      createdAt: now,
      updatedAt: now,
      lastConditionState: serializeAlertConditionState(normalizedLastConditionState),
      lastConditionChangedAt:
        normalizedLastConditionState === null
          ? null
          : normalizeTimestamp(lastConditionChangedAt) || now
    });

    return this.getAlertById(result.lastInsertRowid);
  }

  getAlertById(id) {
    const row = this.requireStatements().selectById.get(normalizeAlertId(id));
    return row ? mapAlertRow(row) : null;
  }

  countActiveAlertsForUser(userId) {
    return Number(
      this.requireStatements().countActiveByUser.get(String(userId || '').trim())?.count || 0
    );
  }

  listActiveAlerts({
    limit = 500
  } = {}) {
    return this.requireStatements()
      .selectActive.all({
        limit: normalizeLimit(limit, 500)
      })
      .map(mapAlertRow);
  }

  listUserAlerts({
    guildId,
    userId,
    includeTriggered = false,
    limit = 25
  }) {
    const rows = includeTriggered
      ? this.requireStatements().selectUserVisible.all({
          guildId: String(guildId),
          userId: String(userId),
          limit: normalizeLimit(limit, 25)
        })
      : this.requireStatements().selectUserActive.all({
          guildId: String(guildId),
          userId: String(userId),
          limit: normalizeLimit(limit, 25)
        });

    return rows.map(mapAlertRow);
  }

  disableAlertForUser({
    id,
    guildId,
    userId,
    reason = 'removed'
  }) {
    const now = new Date().toISOString();
    const result = this.requireStatements().disableForUser.run({
      id: normalizeAlertId(id),
      guildId: String(guildId),
      userId: String(userId),
      reason: normalizeReason(reason),
      updatedAt: now
    });

    return result.changes > 0;
  }

  markAlertChecked({
    id,
    checkedAt = new Date().toISOString()
  }) {
    this.requireStatements().markChecked.run({
      id: normalizeAlertId(id),
      checkedAt,
      updatedAt: checkedAt
    });
  }

  markAlertConditionState({
    id,
    conditionState,
    checkedAt = new Date().toISOString(),
    conditionChangedAt = null
  }) {
    this.requireStatements().markConditionState.run({
      id: normalizeAlertId(id),
      conditionState: serializeAlertConditionState(conditionState),
      conditionChangedAt: normalizeTimestamp(conditionChangedAt),
      checkedAt,
      updatedAt: checkedAt
    });
  }

  markAlertNotified({
    id,
    notifiedAt = new Date().toISOString()
  }) {
    this.requireStatements().markNotified.run({
      id: normalizeAlertId(id),
      notifiedAt,
      updatedAt: notifiedAt
    });
  }

  markAlertTriggered({
    id,
    triggeredAt = new Date().toISOString()
  }) {
    this.requireStatements().markTriggered.run({
      id: normalizeAlertId(id),
      triggeredAt,
      updatedAt: triggeredAt
    });
  }

  markAlertSendFailed({
    id,
    reason,
    failedAt = new Date().toISOString()
  }) {
    this.requireStatements().markSendFailed.run({
      id: normalizeAlertId(id),
      reason: normalizeReason(reason),
      updatedAt: failedAt
    });
  }

  prepareStatements() {
    this.statements = {
      insertAlert: this.db.prepare(`
        INSERT INTO alerts (
          guild_id,
          channel_id,
          user_id,
          item_name,
          country,
          mode,
          repeat_mode,
          flight_type,
          capacity,
          note,
          status,
          created_at,
          updated_at,
          last_condition_state,
          last_condition_changed_at
        ) VALUES (
          @guildId,
          @channelId,
          @userId,
          @itemName,
          @country,
          @mode,
          @repeatMode,
          @flightType,
          @capacity,
          @note,
          'active',
          @createdAt,
          @updatedAt,
          @lastConditionState,
          @lastConditionChangedAt
        )
      `),
      selectById: this.db.prepare(`
        SELECT *
        FROM alerts
        WHERE id = ?
      `),
      countActiveByUser: this.db.prepare(`
        SELECT COUNT(*) AS count
        FROM alerts
        WHERE user_id = ?
          AND status = 'active'
          AND triggered_at IS NULL
      `),
      selectActive: this.db.prepare(`
        SELECT *
        FROM alerts
        WHERE status = 'active'
          AND triggered_at IS NULL
        ORDER BY COALESCE(last_checked_at, created_at) ASC, id ASC
        LIMIT @limit
      `),
      selectUserActive: this.db.prepare(`
        SELECT *
        FROM alerts
        WHERE guild_id = @guildId
          AND user_id = @userId
          AND status = 'active'
          AND triggered_at IS NULL
        ORDER BY created_at ASC, id ASC
        LIMIT @limit
      `),
      selectUserVisible: this.db.prepare(`
        SELECT *
        FROM alerts
        WHERE guild_id = @guildId
          AND user_id = @userId
          AND status IN ('active', 'triggered')
        ORDER BY created_at ASC, id ASC
        LIMIT @limit
      `),
      disableForUser: this.db.prepare(`
        UPDATE alerts
        SET
          status = 'disabled',
          disabled_reason = @reason,
          updated_at = @updatedAt
        WHERE id = @id
          AND guild_id = @guildId
          AND user_id = @userId
          AND status = 'active'
          AND triggered_at IS NULL
      `),
      markChecked: this.db.prepare(`
        UPDATE alerts
        SET
          last_checked_at = @checkedAt,
          updated_at = @updatedAt
        WHERE id = @id
          AND status = 'active'
      `),
      markConditionState: this.db.prepare(`
        UPDATE alerts
        SET
          last_checked_at = @checkedAt,
          last_condition_state = @conditionState,
          last_condition_changed_at = COALESCE(@conditionChangedAt, last_condition_changed_at),
          updated_at = @updatedAt
        WHERE id = @id
          AND status = 'active'
      `),
      markNotified: this.db.prepare(`
        UPDATE alerts
        SET
          last_notified_at = @notifiedAt,
          updated_at = @updatedAt
        WHERE id = @id
          AND status = 'active'
      `),
      markTriggered: this.db.prepare(`
        UPDATE alerts
        SET
          status = 'triggered',
          last_notified_at = @triggeredAt,
          triggered_at = @triggeredAt,
          updated_at = @updatedAt
        WHERE id = @id
          AND status = 'active'
          AND triggered_at IS NULL
      `),
      markSendFailed: this.db.prepare(`
        UPDATE alerts
        SET
          status = 'disabled',
          disabled_reason = @reason,
          updated_at = @updatedAt
        WHERE id = @id
          AND status = 'active'
      `)
    };
  }

  ensureAlertSchema() {
    const columns = new Set(
      this.db.prepare('PRAGMA table_info(alerts)').all().map((row) => row.name)
    );

    if (!columns.has('repeat_mode')) {
      this.db.exec(`
        ALTER TABLE alerts
        ADD COLUMN repeat_mode TEXT NOT NULL DEFAULT 'once'
      `);
    }

    if (!columns.has('last_condition_state')) {
      this.db.exec(`
        ALTER TABLE alerts
        ADD COLUMN last_condition_state TEXT
      `);
    }

    if (!columns.has('last_condition_changed_at')) {
      this.db.exec(`
        ALTER TABLE alerts
        ADD COLUMN last_condition_changed_at TEXT
      `);
    }
  }

  requireStatements() {
    if (!this.statements) {
      throw new Error('AlertStore has not been initialized yet.');
    }

    return this.statements;
  }
}

function mapAlertRow(row) {
  return {
    id: Number(row.id),
    guildId: row.guild_id,
    channelId: row.channel_id,
    userId: row.user_id,
    itemName: row.item_name,
    country: row.country,
    mode: normalizeAlertMode(row.mode),
    repeatMode: normalizeAlertRepeatMode(row.repeat_mode),
    flightType: normalizeFlightType(row.flight_type),
    capacity: normalizeCapacity(row.capacity),
    note: normalizeNote(row.note),
    status: row.status || ALERT_STATUS_ACTIVE,
    disabledReason: row.disabled_reason || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    lastCheckedAt: row.last_checked_at || null,
    lastConditionState: normalizeAlertConditionState(row.last_condition_state),
    lastConditionChangedAt: row.last_condition_changed_at || null,
    lastNotifiedAt: row.last_notified_at || null,
    triggeredAt: row.triggered_at || null
  };
}

function normalizeAlertMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === ALERT_MODE_FLYOUT ? ALERT_MODE_FLYOUT : ALERT_MODE_AVAILABLE;
}

function normalizeAlertRepeatMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === ALERT_REPEAT_EVERY_TIME ? ALERT_REPEAT_EVERY_TIME : ALERT_REPEAT_ONCE;
}

function normalizeAlertConditionState(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    if (value === 1) {
      return true;
    }

    if (value === 0) {
      return false;
    }
  }

  const normalized = String(value || '').trim().toLowerCase();

  if ([ALERT_CONDITION_STATE_TRUE, '1', 'yes', 'ready', 'available'].includes(normalized)) {
    return true;
  }

  if ([ALERT_CONDITION_STATE_FALSE, '0', 'no', 'not_ready', 'unavailable'].includes(normalized)) {
    return false;
  }

  return null;
}

function serializeAlertConditionState(value) {
  const normalized = normalizeAlertConditionState(value);

  if (normalized === null) {
    return null;
  }

  return normalized ? ALERT_CONDITION_STATE_TRUE : ALERT_CONDITION_STATE_FALSE;
}

function normalizeFlightType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized ? normalized.slice(0, 40) : null;
}

function normalizeCapacity(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const numeric = Number.parseInt(value, 10);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function normalizeNote(value) {
  const normalized = String(value || '').trim();
  return normalized ? normalized.slice(0, 200) : null;
}

function normalizeReason(value) {
  const normalized = String(value || '').trim();
  return normalized ? normalized.slice(0, 500) : null;
}

function normalizeAlertId(value) {
  const id = Number.parseInt(value, 10);

  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('Alert ID must be a positive number.');
  }

  return id;
}

function normalizeTimestamp(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function normalizeLimit(value, fallback) {
  const limit = Number.parseInt(value, 10);
  return Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1000) : fallback;
}

module.exports = {
  ALERT_MODE_AVAILABLE,
  ALERT_MODE_FLYOUT,
  ALERT_REPEAT_EVERY_TIME,
  ALERT_REPEAT_ONCE,
  ALERT_STATUS_ACTIVE,
  ALERT_STATUS_DISABLED,
  ALERT_STATUS_TRIGGERED,
  DEFAULT_MAX_ACTIVE_ALERTS_PER_USER,
  AlertStore,
  normalizeAlertConditionState,
  normalizeAlertMode,
  normalizeAlertRepeatMode
};
