const {
  ALERT_MODE_AVAILABLE,
  ALERT_MODE_FLYOUT,
  ALERT_REPEAT_EVERY_TIME,
  normalizeAlertConditionState,
  normalizeAlertRepeatMode
} = require('./alertStore');

const DEFAULT_ALERT_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const DISCORD_MESSAGE_LIMIT = 2000;
const DEFAULT_ALERT_PREVIEW_SETTINGS = Object.freeze({
  flightType: 'private',
  capacity: 19,
  sellTarget: 'market',
  marketTax: true
});

class AlertService {
  constructor({
    discordClient,
    droqsdbClient,
    alertStore,
    logger = console,
    checkIntervalMs = DEFAULT_ALERT_CHECK_INTERVAL_MS
  }) {
    this.discordClient = discordClient;
    this.droqsdbClient = droqsdbClient;
    this.alertStore = alertStore;
    this.logger = logger;
    this.checkIntervalMs = Math.max(60_000, Math.floor(Number(checkIntervalMs) || DEFAULT_ALERT_CHECK_INTERVAL_MS));
    this.timer = null;
    this.started = false;
    this.isChecking = false;
  }

  async start() {
    if (this.started) {
      return;
    }

    await this.alertStore.initialize();
    this.timer = setInterval(() => {
      void this.runOnce().catch((error) => {
        this.logger.error('alerts.check_unhandled_failed', error);
      });
    }, this.checkIntervalMs);

    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }

    this.started = true;
    this.logger.info('alerts.scheduler_started', {
      checkIntervalMs: this.checkIntervalMs
    });
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.isChecking = false;
    this.started = false;
    this.alertStore.close();
    this.logger.info('alerts.scheduler_stopped');
  }

  createAlert(payload) {
    return this.alertStore.createAlert(payload);
  }

  listUserAlerts(payload) {
    return this.alertStore.listUserAlerts(payload);
  }

  countActiveAlertsForUser(userId) {
    return this.alertStore.countActiveAlertsForUser(userId);
  }

  removeUserAlert(payload) {
    return this.alertStore.disableAlertForUser(payload);
  }

  async runOnce() {
    if (this.isChecking) {
      this.logger.warn('alerts.check_skipped_overlap');
      return;
    }

    this.isChecking = true;
    const startedAt = Date.now();
    const alerts = this.alertStore.listActiveAlerts();
    const cache = new Map();
    let triggeredCount = 0;

    try {
      for (const alert of alerts) {
        try {
          const result = await this.evaluateAlert(alert, cache);
          const evaluatedAt = new Date().toISOString();
          const shouldNotify = this.shouldNotifyAlert(alert, result);
          this.recordAlertConditionState(alert, result, evaluatedAt);

          if (!shouldNotify) {
            continue;
          }

          const sent = await this.sendAlertNotification(alert, result);

          if (sent) {
            if (normalizeAlertRepeatMode(alert.repeatMode) === ALERT_REPEAT_EVERY_TIME) {
              this.alertStore.markAlertNotified({
                id: alert.id
              });
            } else {
              this.alertStore.markAlertTriggered({
                id: alert.id
              });
            }
            triggeredCount += 1;
          }
        } catch (error) {
          this.logger.warn('alerts.check_alert_failed', error, {
            alertId: alert.id,
            country: alert.country,
            itemName: alert.itemName,
            mode: alert.mode,
            userId: alert.userId
          });
        }
      }
    } finally {
      this.isChecking = false;
    }

    this.logger.info('alerts.check_completed', {
      checkedCount: alerts.length,
      durationMs: Date.now() - startedAt,
      triggeredCount
    });
  }

  async evaluateAlert(alert, cache) {
    const preview = await this.getAlertPreviewCached(alert, cache);
    const conditionActive = resolveAlertPreviewCondition(preview);

    return {
      conditionActive,
      shouldNotify: conditionActive,
      message: buildAlertPreviewMessage(alert, preview),
      preview
    };
  }

  shouldNotifyAlert(alert, result) {
    if (result?.shouldNotify !== true) {
      return false;
    }

    if (normalizeAlertRepeatMode(alert.repeatMode) !== ALERT_REPEAT_EVERY_TIME) {
      return true;
    }

    return normalizeAlertConditionState(alert.lastConditionState) !== true;
  }

  recordAlertConditionState(alert, result, evaluatedAt = new Date().toISOString()) {
    const conditionActive = result?.conditionActive === true || result?.shouldNotify === true;
    const previousConditionState = normalizeAlertConditionState(alert.lastConditionState);
    const conditionChangedAt =
      previousConditionState === conditionActive ? null : evaluatedAt;

    if (typeof this.alertStore.markAlertConditionState === 'function') {
      this.alertStore.markAlertConditionState({
        id: alert.id,
        conditionState: conditionActive,
        checkedAt: evaluatedAt,
        conditionChangedAt
      });
      return;
    }

    this.alertStore.markAlertChecked({
      id: alert.id,
      checkedAt: evaluatedAt
    });
  }

  async getAlertPreviewCached(alert, cache) {
    const request = this.buildAlertPreviewRequest(alert);
    const key = [
      'alert-preview',
      normalizeKey(request.item),
      normalizeKey(request.country),
      normalizeKey(request.mode),
      normalizeKey(request.flightType),
      request.capacity || '',
      normalizeKey(request.sellTarget),
      request.marketTax === false ? 'no_tax' : 'tax'
    ].join(':');

    if (!cache.has(key)) {
      cache.set(key, this.droqsdbClient.queryAlertPreview(request));
    }

    return cache.get(key);
  }

  buildAlertPreviewRequest(alert) {
    const settings = this.resolveAlertPreviewSettings(alert);

    return {
      item: alert.itemName,
      country: alert.country,
      mode: alert.mode === ALERT_MODE_FLYOUT ? ALERT_MODE_FLYOUT : ALERT_MODE_AVAILABLE,
      flightType: settings.flightType,
      capacity: settings.capacity,
      sellTarget: settings.sellTarget,
      marketTax: settings.marketTax
    };
  }

  resolveAlertPreviewSettings(alert) {
    const overrides = {
      flightType: alert.flightType || undefined,
      capacity: alert.capacity || undefined,
      sellTarget: alert.sellTarget || undefined,
      marketTax: typeof alert.marketTax === 'boolean' ? alert.marketTax : undefined
    };

    if (typeof this.droqsdbClient.getBotAlertPreviewSettings === 'function') {
      return this.droqsdbClient.getBotAlertPreviewSettings(overrides);
    }

    return {
      ...DEFAULT_ALERT_PREVIEW_SETTINGS,
      ...(overrides.flightType ? { flightType: overrides.flightType } : {}),
      ...(overrides.capacity ? { capacity: overrides.capacity } : {}),
      ...(overrides.sellTarget ? { sellTarget: overrides.sellTarget } : {}),
      ...(typeof overrides.marketTax === 'boolean' ? { marketTax: overrides.marketTax } : {})
    };
  }

  async sendAlertNotification(alert, result) {
    let user;

    try {
      user = await this.discordClient.users.fetch(alert.userId);
    } catch (error) {
      this.logger.warn('alerts.dm_user_fetch_failed', error, {
        alertId: alert.id,
        guildId: alert.guildId,
        userId: alert.userId
      });
      this.alertStore.markAlertSendFailed({
        id: alert.id,
        reason: 'dm_user_fetch_failed'
      });
      return false;
    }

    if (!user || typeof user.send !== 'function') {
      this.logger.warn('alerts.dm_user_unavailable', {
        alertId: alert.id,
        guildId: alert.guildId,
        userId: alert.userId
      });
      this.alertStore.markAlertSendFailed({
        id: alert.id,
        reason: 'dm_user_unavailable'
      });
      return false;
    }

    try {
      await user.send({
        content: limitDiscordMessage(result.message),
        allowedMentions: {
          parse: []
        }
      });
      return true;
    } catch (error) {
      this.logger.warn('alerts.dm_send_failed', error, {
        alertId: alert.id,
        guildId: alert.guildId,
        userId: alert.userId
      });
      this.alertStore.markAlertSendFailed({
        id: alert.id,
        reason: 'dm_failed'
      });
      return false;
    }
  }
}

function resolveAlertPreviewCondition(preview) {
  if (typeof preview?.shouldNotifyNow === 'boolean') {
    return preview.shouldNotifyNow;
  }

  if (typeof preview?.shouldNotify === 'boolean') {
    return preview.shouldNotify;
  }

  if (typeof preview?.isConditionMet === 'boolean') {
    return preview.isConditionMet;
  }

  return false;
}

function buildAlertPreviewMessage(alert, preview) {
  const mode = preview?.mode === ALERT_MODE_FLYOUT || alert.mode === ALERT_MODE_FLYOUT
    ? ALERT_MODE_FLYOUT
    : ALERT_MODE_AVAILABLE;
  const itemName = cleanText(preview?.itemName || alert.itemName || 'Item');
  const country = cleanText(preview?.country || alert.country || 'Unknown country');
  const capacity = toNumber(preview?.capacity ?? alert.capacity);
  const buyPrice = toNumber(preview?.buyPrice ?? preview?.itemBuyPrice);
  const totalRunCost =
    toNumber(preview?.totalRunCost ?? preview?.estimatedRunCost) ||
    (buyPrice !== null && capacity !== null ? buyPrice * capacity : null);
  const currentStock = toNumber(preview?.currentStock ?? preview?.stock);
  const flightType = cleanText(preview?.flightType || alert.flightType);
  const flightLength = cleanText(preview?.flightLengthLabel) ||
    (toNumber(preview?.flightLengthMinutes) !== null
      ? formatDurationMinutes(preview.flightLengthMinutes)
      : null);
  const arrivalAtTct = cleanText(preview?.arrivalAtTct);
  const restockWindow = getWindowLabel(preview?.restockWindow) ||
    cleanText(preview?.restockWindowLabel);
  const stockoutWindow = getWindowLabel(preview?.stockoutWindow) ||
    cleanText(preview?.stockoutWindowLabel) ||
    cleanText(preview?.estimatedStockoutAtTct) ||
    cleanText(preview?.stockoutAtTct);
  const safetyWindow = getWindowLabel(preview?.safetyWindow) ||
    cleanText(preview?.safetyWindowLabel);
  const confidence = cleanText(preview?.confidence);
  const freshness = cleanText(preview?.snapshotFreshness || preview?.dataState);
  const predictionReason = cleanText(preview?.predictionReason || preview?.reason);
  const lines = [
    `\u{1F6A8} DroqsDB ${mode === ALERT_MODE_FLYOUT ? 'Fly-out' : 'Stock'} Alert`,
    '',
    mode === ALERT_MODE_FLYOUT
      ? `${itemName} - ${country}`
      : `${itemName} - ${country} is available now.`,
    ''
  ];

  if (mode === ALERT_MODE_FLYOUT) {
    lines.push(`Leave now if you want ${itemName} to be in stock on arrival.`);
    lines.push('');
  }

  if (currentStock !== null) {
    lines.push(`Stock: ${formatCount(currentStock)}`);
  }

  if (buyPrice !== null) {
    lines.push(`Buy price: ${formatMoney(buyPrice)}`);
  }

  if (capacity !== null) {
    lines.push(`Capacity: ${formatCount(capacity)}`);
  }

  if (totalRunCost !== null) {
    lines.push(`Estimated run cost: ${formatMoney(totalRunCost)}`);
  }

  if (flightType || flightLength) {
    const flightParts = [
      flightType ? formatFlightTypeLabel(flightType) : null,
      flightLength ? `~${flightLength}` : null
    ].filter(Boolean);
    lines.push(`Flight: ${flightParts.join(', ')}`);
  }

  if (mode === ALERT_MODE_FLYOUT && arrivalAtTct) {
    lines.push(`Arrival: ${arrivalAtTct}`);
  }

  if (restockWindow) {
    lines.push(`Restock window: ${restockWindow}`);
  }

  if (stockoutWindow) {
    lines.push(`Estimated stockout: ${stockoutWindow}`);
  }

  if (safetyWindow) {
    lines.push(`Safety window: ${safetyWindow}`);
  }

  if (confidence) {
    lines.push(`Confidence: ${formatTitleLabel(confidence)}`);
  }

  lines.push(`Source: DroqsDB${freshness ? `, ${freshness}` : ''}`);

  if (predictionReason) {
    lines.push('', `Reason: ${predictionReason}`);
  }

  const apiLines = normalizeNotificationLines(preview?.notificationLines)
    .filter((line) => !lineAlreadyIncluded(lines, line))
    .slice(0, 6);

  if (apiLines.length) {
    lines.push('', ...apiLines);
  }

  lines.push('', 'Forecasts are estimates, not guarantees.');

  return sanitizeDiscordText(lines.join('\n').replace(/\n{3,}/g, '\n\n'));
}

function getWindowLabel(value) {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    return cleanText(value);
  }

  if (typeof value === 'object') {
    return cleanText(value.label || value.windowLabel || value.description);
  }

  return null;
}

function normalizeNotificationLines(lines) {
  return (Array.isArray(lines) ? lines : [])
    .map(cleanText)
    .filter(Boolean);
}

function lineAlreadyIncluded(lines, candidate) {
  const normalizedCandidate = normalizeKey(candidate);
  return lines.some((line) => normalizeKey(line) === normalizedCandidate);
}

function formatMoney(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0
  }).format(Number(value) || 0);
}

function formatFlightTypeLabel(value) {
  const normalized = cleanText(value);

  if (!normalized) {
    return null;
  }

  return normalized
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatTitleLabel(value) {
  return cleanText(value)
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function cleanText(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function sanitizeDiscordText(value) {
  return String(value || '').replace(/@/g, '@\u200b');
}

function limitDiscordMessage(value) {
  const normalized = String(value || '').trim();

  if (normalized.length <= DISCORD_MESSAGE_LIMIT) {
    return normalized;
  }

  return `${normalized.slice(0, DISCORD_MESSAGE_LIMIT - 20).trimEnd()}\n...`;
}

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function formatCount(value) {
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 0
  }).format(Number(value) || 0);
}

function formatDurationMinutes(value) {
  const minutes = Math.max(0, Math.round(Number(value) || 0));
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  const parts = [];

  if (hours > 0) {
    parts.push(`${hours}h`);
  }

  if (remainingMinutes > 0 || !parts.length) {
    parts.push(`${remainingMinutes}m`);
  }

  return parts.join(' ');
}

module.exports = {
  DEFAULT_ALERT_CHECK_INTERVAL_MS,
  AlertService
};
