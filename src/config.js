const path = require('node:path');
require('dotenv').config();

const ROOT_DIR = path.resolve(__dirname, '..');

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const config = {
  rootDir: ROOT_DIR,
  discordToken: process.env.DISCORD_TOKEN || '',
  clientId: process.env.DISCORD_CLIENT_ID || '',
  guildId: process.env.DISCORD_GUILD_ID || '',
  logLevel: process.env.LOG_LEVEL || 'info',
  droqsdbApiBaseUrl: process.env.DROQSDB_API_BASE_URL || 'https://droqsdb.com/api/public/v1',
  droqsdbWebBaseUrl: process.env.DROQSDB_WEB_BASE_URL || 'https://droqsdb.com',
  apiCacheTtlMs: parsePositiveInteger(process.env.API_CACHE_TTL_MS, 30_000),
  apiCacheStaleTtlMs: parsePositiveInteger(process.env.API_CACHE_STALE_TTL_MS, 120_000),
  droqsdbApiTimeoutMs: parsePositiveInteger(process.env.DROQSDB_API_TIMEOUT_MS, 30_000),
  alertCheckIntervalMs: parsePositiveInteger(process.env.ALERT_CHECK_INTERVAL_MS, 5 * 60 * 1000),
  commandUserRateLimitWindowMs: parsePositiveInteger(
    process.env.COMMAND_USER_RATE_LIMIT_WINDOW_MS,
    10_000
  ),
  commandUserRateLimitMax: parsePositiveInteger(process.env.COMMAND_USER_RATE_LIMIT_MAX, 5),
  commandGuildRateLimitWindowMs: parsePositiveInteger(
    process.env.COMMAND_GUILD_RATE_LIMIT_WINDOW_MS,
    10_000
  ),
  commandGuildRateLimitMax: parsePositiveInteger(process.env.COMMAND_GUILD_RATE_LIMIT_MAX, 20),
  autopostCron: process.env.AUTOPOST_CRON || '0 * * * *',
  autopostTimezone: process.env.AUTOPOST_TIMEZONE || 'America/Chicago',
  dailyForecastCron: process.env.DAILY_FORECAST_CRON || '* * * * *',
  dailyForecastTimezone: process.env.DAILY_FORECAST_TIMEZONE || 'UTC',
  autopostDbFile: path.resolve(ROOT_DIR, process.env.AUTOPOST_DB_FILE || './data/autopost.sqlite'),
  legacyAutopostDataFile: path.resolve(
    ROOT_DIR,
    process.env.AUTOPOST_DATA_FILE || './data/autopost-config.json'
  )
};

function assertBotConfig() {
  const missing = [];

  if (!config.discordToken) {
    missing.push('DISCORD_TOKEN');
  }

  if (!config.clientId) {
    missing.push('DISCORD_CLIENT_ID');
  }

  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

module.exports = {
  config,
  assertBotConfig
};
