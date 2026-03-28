const fs = require('node:fs/promises');
const path = require('node:path');
const Database = require('better-sqlite3');
const {
  DEFAULT_AUTOPOST_COUNT,
  normalizeAutopostCount,
  normalizeAutopostMode,
  normalizeAutopostFilters
} = require('../utils/autopost');

class GuildConfigStore {
  constructor({
    databasePath,
    legacyStoragePath = null,
    logger = console
  }) {
    this.databasePath = databasePath;
    this.legacyStoragePath = legacyStoragePath;
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
      CREATE TABLE IF NOT EXISTS guild_autopost_configs (
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

      CREATE INDEX IF NOT EXISTS idx_guild_autopost_enabled
      ON guild_autopost_configs (autopost_enabled);
    `);

    this.ensureGuildAutopostConfigSchema();
    this.prepareStatements();
    await this.importLegacyStateIfNeeded();
    this.logger.info('guild_config_store.initialized', {
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
    this.logger.info('guild_config_store.closed', {
      databasePath: this.databasePath
    });
  }

  getGuildConfig(guildId) {
    const row = this.requireStatements().selectByGuildId.get(String(guildId));
    return row ? mapGuildConfigRow(row) : null;
  }

  listEnabledGuildConfigs() {
    return this.requireStatements()
      .selectEnabled.all()
      .map(mapGuildConfigRow);
  }

  saveGuildAutopostConfig({
    guildId,
    channelId,
    count = DEFAULT_AUTOPOST_COUNT,
    mode = 'top_n',
    countries = [],
    categories = [],
    country = null,
    category = null,
    updatedBy = null
  }) {
    const filters = normalizeAutopostFilters({
      countries,
      categories,
      country,
      category
    });
    const row = {
      guildId: String(guildId),
      channelId: String(channelId),
      count: normalizeAutopostCount(count),
      mode: normalizeAutopostMode(mode),
      country: null,
      category: null,
      countries: JSON.stringify(filters.countries),
      categories: JSON.stringify(filters.categories),
      updatedAt: new Date().toISOString(),
      updatedBy: updatedBy ? String(updatedBy) : null
    };

    this.requireStatements().upsertGuild.run(row);
    return this.getGuildConfig(guildId);
  }

  disableGuildAutopost({
    guildId,
    updatedBy = null
  }) {
    this.requireStatements().disableGuild.run({
      guildId: String(guildId),
      count: DEFAULT_AUTOPOST_COUNT,
      updatedAt: new Date().toISOString(),
      updatedBy: updatedBy ? String(updatedBy) : null
    });

    return this.getGuildConfig(guildId);
  }

  prepareStatements() {
    this.statements = {
      countGuilds: this.db.prepare('SELECT COUNT(*) AS count FROM guild_autopost_configs'),
      selectByGuildId: this.db.prepare(`
        SELECT
          guild_id,
          autopost_enabled,
          channel_id,
          count,
          preset_mode,
          preset_country,
          preset_category,
          preset_countries,
          preset_categories,
          updated_at,
          updated_by
        FROM guild_autopost_configs
        WHERE guild_id = ?
      `),
      selectEnabled: this.db.prepare(`
        SELECT
          guild_id,
          autopost_enabled,
          channel_id,
          count,
          preset_mode,
          preset_country,
          preset_category,
          preset_countries,
          preset_categories,
          updated_at,
          updated_by
        FROM guild_autopost_configs
        WHERE autopost_enabled = 1
        ORDER BY guild_id ASC
      `),
      upsertGuild: this.db.prepare(`
        INSERT INTO guild_autopost_configs (
          guild_id,
          autopost_enabled,
          channel_id,
          count,
          preset_mode,
          preset_country,
          preset_category,
          preset_countries,
          preset_categories,
          updated_at,
          updated_by
        ) VALUES (
          @guildId,
          1,
          @channelId,
          @count,
          @mode,
          @country,
          @category,
          @countries,
          @categories,
          @updatedAt,
          @updatedBy
        )
        ON CONFLICT(guild_id) DO UPDATE SET
          autopost_enabled = excluded.autopost_enabled,
          channel_id = excluded.channel_id,
          count = excluded.count,
          preset_mode = excluded.preset_mode,
          preset_country = excluded.preset_country,
          preset_category = excluded.preset_category,
          preset_countries = excluded.preset_countries,
          preset_categories = excluded.preset_categories,
          updated_at = excluded.updated_at,
          updated_by = excluded.updated_by
      `),
      disableGuild: this.db.prepare(`
        INSERT INTO guild_autopost_configs (
          guild_id,
          autopost_enabled,
          count,
          updated_at,
          updated_by
        ) VALUES (
          @guildId,
          0,
          @count,
          @updatedAt,
          @updatedBy
        )
        ON CONFLICT(guild_id) DO UPDATE SET
          autopost_enabled = 0,
          updated_at = excluded.updated_at,
          updated_by = excluded.updated_by
      `)
    };
  }

  requireStatements() {
    if (!this.statements) {
      throw new Error('GuildConfigStore has not been initialized yet.');
    }

    return this.statements;
  }

  ensureGuildAutopostConfigSchema() {
    const columns = this.db
      .prepare('PRAGMA table_info(guild_autopost_configs)')
      .all()
      .map((column) => column.name);

    if (!columns.includes('preset_mode')) {
      this.db.exec(
        "ALTER TABLE guild_autopost_configs ADD COLUMN preset_mode TEXT NOT NULL DEFAULT 'top_n'"
      );
    }

    if (!columns.includes('preset_countries')) {
      this.db.exec(
        "ALTER TABLE guild_autopost_configs ADD COLUMN preset_countries TEXT NOT NULL DEFAULT '[]'"
      );
    }

    if (!columns.includes('preset_categories')) {
      this.db.exec(
        "ALTER TABLE guild_autopost_configs ADD COLUMN preset_categories TEXT NOT NULL DEFAULT '[]'"
      );
    }
  }

  async importLegacyStateIfNeeded() {
    if (!this.legacyStoragePath) {
      return;
    }

    const existingGuildCount = this.requireStatements().countGuilds.get()?.count || 0;

    if (existingGuildCount > 0) {
      return;
    }

    let rawState;

    try {
      rawState = await fs.readFile(this.legacyStoragePath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.logger.error('guild_config_store.legacy_read_failed', error, {
          legacyStoragePath: this.legacyStoragePath
        });
      }

      return;
    }

    let parsedState;

    try {
      parsedState = JSON.parse(rawState);
    } catch (error) {
      this.logger.error('guild_config_store.legacy_parse_failed', error, {
        legacyStoragePath: this.legacyStoragePath
      });
      return;
    }

    const guildEntries = Object.entries(
      parsedState && typeof parsedState.guilds === 'object' ? parsedState.guilds : {}
    );

    if (!guildEntries.length) {
      return;
    }

    const importTransaction = this.db.transaction((entries) => {
      for (const [guildId, legacyConfig] of entries) {
        if (!legacyConfig?.channelId) {
          continue;
        }

        this.statements.upsertGuild.run({
          guildId: String(guildId),
          channelId: String(legacyConfig.channelId),
          count: DEFAULT_AUTOPOST_COUNT,
          mode: 'top_n',
          country: null,
          category: null,
          countries: '[]',
          categories: '[]',
          updatedAt:
            typeof legacyConfig.updatedAt === 'string' && legacyConfig.updatedAt
              ? legacyConfig.updatedAt
              : new Date().toISOString(),
          updatedBy: legacyConfig.updatedBy ? String(legacyConfig.updatedBy) : null
        });
      }
    });

    importTransaction(guildEntries);
    this.logger.info('guild_config_store.legacy_imported', {
      guildCount: guildEntries.length,
      legacyStoragePath: this.legacyStoragePath
    });
  }
}

function mapGuildConfigRow(row) {
  const countries = getStoredAutopostFilterArray(row.preset_countries, row.preset_country, 'country');
  const categories = getStoredAutopostFilterArray(row.preset_categories, row.preset_category, 'category');

  return {
    guildId: row.guild_id,
    autopostEnabled: Boolean(row.autopost_enabled),
    channelId: row.channel_id || null,
    count: normalizeAutopostCount(row.count),
    mode: normalizeAutopostMode(row.preset_mode),
    country: countries.length === 1 ? countries[0] : null,
    category: categories.length === 1 ? categories[0] : null,
    countries,
    categories,
    updatedAt: row.updated_at || null,
    updatedBy: row.updated_by || null
  };
}

function getStoredAutopostFilterArray(serializedValue, legacyValue, filterKey) {
  const collectionKey = filterKey === 'country' ? 'countries' : 'categories';
  let parsedValues = [];

  try {
    const parsed = JSON.parse(String(serializedValue || '[]'));
    parsedValues = Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    parsedValues = [];
  }

  const normalized = normalizeAutopostFilters({
    [filterKey]: legacyValue,
    [collectionKey]: parsedValues
  });

  return normalized[collectionKey];
}

module.exports = {
  GuildConfigStore
};
