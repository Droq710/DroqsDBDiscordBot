const DEFAULT_DAILY_FORECAST_COUNT = 10;
const MIN_DAILY_FORECAST_COUNT = 1;
const MAX_DAILY_FORECAST_COUNT = 10;
const DEFAULT_DAILY_FORECAST_TIME = '08:00';
const DAILY_FORECAST_POST_GRACE_MINUTES = 10;

function normalizeDailyForecastCount(value, fallback = DEFAULT_DAILY_FORECAST_COUNT) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed)) {
    return fallback;
  }

  return Math.min(MAX_DAILY_FORECAST_COUNT, Math.max(MIN_DAILY_FORECAST_COUNT, parsed));
}

function normalizeDailyForecastTime(value, fallback = DEFAULT_DAILY_FORECAST_TIME) {
  const normalized = String(value || '').trim();
  const match = normalized.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);

  if (!match) {
    return fallback;
  }

  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

function parseDailyForecastTime(value) {
  const normalized = String(value || '').trim();
  const match = normalized.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);

  if (!match) {
    throw new Error('Daily forecast time must use HH:mm in TCT, for example 08:00.');
  }

  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

function getTctDateKey(value = new Date()) {
  const date = normalizeDate(value);
  return date ? date.toISOString().slice(0, 10) : null;
}

function getTctTimeKey(value = new Date()) {
  const date = normalizeDate(value);

  if (!date) {
    return null;
  }

  return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
}

function isDailyForecastDue(config, value = new Date(), {
  graceMinutes = DAILY_FORECAST_POST_GRACE_MINUTES
} = {}) {
  if (!config?.dailyForecastEnabled) {
    return false;
  }

  const date = normalizeDate(value);
  const dateKey = getTctDateKey(date);

  if (!date || !dateKey || config.dailyForecastLastPostDate === dateKey) {
    return false;
  }

  const currentMinutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  const targetMinutes = timeToMinutes(normalizeDailyForecastTime(config.dailyForecastTime));
  const grace = Math.max(1, Number.parseInt(graceMinutes, 10) || DAILY_FORECAST_POST_GRACE_MINUTES);

  return currentMinutes >= targetMinutes && currentMinutes < targetMinutes + grace;
}

function timeToMinutes(value) {
  const [hours, minutes] = normalizeDailyForecastTime(value).split(':').map((part) => Number.parseInt(part, 10));
  return hours * 60 + minutes;
}

function normalizeDate(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

module.exports = {
  DAILY_FORECAST_POST_GRACE_MINUTES,
  DEFAULT_DAILY_FORECAST_COUNT,
  DEFAULT_DAILY_FORECAST_TIME,
  MAX_DAILY_FORECAST_COUNT,
  MIN_DAILY_FORECAST_COUNT,
  getTctDateKey,
  getTctTimeKey,
  isDailyForecastDue,
  normalizeDailyForecastCount,
  normalizeDailyForecastTime,
  parseDailyForecastTime
};
