const { randomInt } = require('node:crypto');

const GIVEAWAY_EMOJI = '✈️';
const GIVEAWAY_END_MODE_TIME = 'time';
const GIVEAWAY_END_MODE_ENTRIES = 'entries';
const DEFAULT_GIVEAWAY_WINNER_COOLDOWN_MS = 3 * 60 * 1000;
const ENTRY_MODE_PLACEHOLDER_END_AT = '9999-12-31T23:59:59.999Z';
const MIN_GIVEAWAY_DURATION_MS = 60_000;
const MAX_GIVEAWAY_DURATION_MS = 14 * 24 * 60 * 60 * 1000;

function parseGiveawayDuration(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
  const match = normalized.match(/^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/);

  if (!match || (!match[1] && !match[2] && !match[3])) {
    throw new Error(
      'Duration must use `d`, `h`, and/or `m`, for example `15m`, `2h`, `1d6h`, or `2d3h30m`.'
    );
  }

  const days = Number.parseInt(match[1] || '0', 10);
  const hours = Number.parseInt(match[2] || '0', 10);
  const minutes = Number.parseInt(match[3] || '0', 10);
  const totalMinutes = (days * 24 * 60) + (hours * 60) + minutes;
  const durationMs = totalMinutes * 60 * 1000;

  if (durationMs < MIN_GIVEAWAY_DURATION_MS) {
    throw new Error('Giveaway duration must be at least 1 minute.');
  }

  if (durationMs > MAX_GIVEAWAY_DURATION_MS) {
    throw new Error('Giveaway duration cannot be longer than 14 days.');
  }

  return {
    durationMs,
    days,
    hours,
    minutes,
    normalized: [
      days > 0 ? `${days}d` : '',
      hours > 0 ? `${hours}h` : '',
      minutes > 0 ? `${minutes}m` : ''
    ].join('')
  };
}

function chooseRandomEntries(entries, count) {
  const uniqueEntries = Array.from(
    new Set(
      Array.isArray(entries)
        ? entries
            .map((entry) => String(entry || '').trim())
            .filter(Boolean)
        : []
    )
  );
  const normalizedCount = Math.max(0, Math.floor(Number(count) || 0));

  if (!uniqueEntries.length || normalizedCount <= 0) {
    return [];
  }

  const pool = uniqueEntries.slice();
  const selectedCount = Math.min(normalizedCount, pool.length);

  for (let index = pool.length - 1; index > pool.length - 1 - selectedCount; index -= 1) {
    const swapIndex = randomInt(index + 1);
    const current = pool[index];
    pool[index] = pool[swapIndex];
    pool[swapIndex] = current;
  }

  return pool.slice(pool.length - selectedCount);
}

function normalizeGiveawayMessageId(value) {
  const normalized = String(value || '').trim();

  if (!/^\d+$/.test(normalized)) {
    throw new Error('Message ID must be a valid Discord message ID.');
  }

  return normalized;
}

function normalizeEmojiName(value) {
  return String(value || '').replace(/\uFE0F/g, '');
}

function normalizeGiveawayEndMode(value) {
  return String(value || '').trim().toLowerCase() === GIVEAWAY_END_MODE_ENTRIES
    ? GIVEAWAY_END_MODE_ENTRIES
    : GIVEAWAY_END_MODE_TIME;
}

function normalizeGiveawayMaxEntries(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const numeric = Number(value);

  if (!Number.isFinite(numeric)) {
    return null;
  }

  const normalized = Math.max(1, Math.floor(numeric));
  return Number.isFinite(normalized) ? normalized : null;
}

function normalizeGiveawayWinnerCooldownEnabled(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

function normalizeGiveawayWinnerCooldownMs(value) {
  const numeric = Number(value);

  if (!Number.isFinite(numeric) || numeric <= 0) {
    return DEFAULT_GIVEAWAY_WINNER_COOLDOWN_MS;
  }

  return Math.max(1_000, Math.floor(numeric));
}

function formatDurationWords(value) {
  const totalSeconds = Math.max(1, Math.ceil(Number(value) / 1000) || 0);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];

  if (hours > 0) {
    parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
  }

  if (minutes > 0) {
    parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);
  }

  if (!hours && seconds > 0) {
    parts.push(`${seconds} second${seconds === 1 ? '' : 's'}`);
  }

  return parts.join(' ') || '1 second';
}

function isGiveawayExpired(giveaway, now = Date.now()) {
  if (!giveaway) {
    return false;
  }

  if (giveaway.status === 'ended' || giveaway.status === 'ending') {
    return true;
  }

  if (normalizeGiveawayEndMode(giveaway.endMode) !== GIVEAWAY_END_MODE_TIME) {
    return false;
  }

  const endAtMs = Date.parse(giveaway.endAt || '');
  return Number.isFinite(endAtMs) && endAtMs <= now;
}

module.exports = {
  DEFAULT_GIVEAWAY_WINNER_COOLDOWN_MS,
  ENTRY_MODE_PLACEHOLDER_END_AT,
  GIVEAWAY_EMOJI,
  GIVEAWAY_END_MODE_ENTRIES,
  GIVEAWAY_END_MODE_TIME,
  MAX_GIVEAWAY_DURATION_MS,
  MIN_GIVEAWAY_DURATION_MS,
  chooseRandomEntries,
  formatDurationWords,
  isGiveawayExpired,
  normalizeEmojiName,
  normalizeGiveawayEndMode,
  normalizeGiveawayMaxEntries,
  normalizeGiveawayMessageId,
  normalizeGiveawayWinnerCooldownEnabled,
  normalizeGiveawayWinnerCooldownMs,
  parseGiveawayDuration
};
