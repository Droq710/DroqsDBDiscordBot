const {
  ALERT_MODE_AVAILABLE,
  ALERT_MODE_FLYOUT,
  ALERT_REPEAT_EVERY_TIME,
  normalizeAlertConditionState,
  normalizeAlertRepeatMode
} = require('./alertStore');

const DEFAULT_ALERT_CHECK_INTERVAL_MS = 5 * 60 * 1000;

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
    if (alert.mode === ALERT_MODE_FLYOUT) {
      return this.evaluateFlyoutAlert(alert, cache);
    }

    return this.evaluateAvailableAlert(alert, cache);
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

  async evaluateAvailableAlert(alert, cache) {
    const snapshot = await this.getItemCountrySnapshotCached(alert, cache);
    const stock = Number(snapshot.countryRow?.stock);
    const isAvailable = Number.isFinite(stock) && stock > 0;

    return {
      conditionActive: isAvailable,
      shouldNotify: isAvailable,
      message: buildAvailableAlertMessage(alert, snapshot),
      snapshot
    };
  }

  async evaluateFlyoutAlert(alert, cache) {
    const planner = await this.getPlannerSnapshotCached(alert, cache);
    const run = findMatchingPlannerRun(planner.runs, alert);

    if (!run) {
      return {
        conditionActive: false,
        shouldNotify: false,
        message: null,
        planner
      };
    }

    const departInMinutes = toNumber(run.departInMinutes);
    const isProjectedViable =
      run.isProjectedViable === true ||
      String(run.availabilityState || '').trim().toLowerCase() === 'projected_on_arrival';
    const isCurrentlyInStock =
      run.isCurrentlyInStock === true || toNumber(run.stock) > 0;
    const shouldNotify = isCurrentlyInStock || (isProjectedViable && departInMinutes !== null && departInMinutes <= 0);

    return {
      conditionActive: shouldNotify,
      shouldNotify,
      message: buildFlyoutAlertMessage(alert, run),
      planner,
      run
    };
  }

  async getItemCountrySnapshotCached(alert, cache) {
    const key = `snapshot:${normalizeKey(alert.itemName)}:${normalizeKey(alert.country)}`;

    if (!cache.has(key)) {
      cache.set(key, this.droqsdbClient.getItemCountrySnapshot(alert.itemName, alert.country));
    }

    return cache.get(key);
  }

  async getPlannerSnapshotCached(alert, cache) {
    const settings = buildPlannerSettings(alert);
    const key = [
      'planner',
      normalizeKey(alert.itemName),
      normalizeKey(alert.country),
      normalizeKey(settings.flightType),
      settings.capacity || ''
    ].join(':');

    if (!cache.has(key)) {
      cache.set(
        key,
        this.droqsdbClient.queryTravelPlanner({
          countries: [alert.country],
          itemNames: [alert.itemName],
          limit: 10,
          settings
        })
      );
    }

    return cache.get(key);
  }

  async sendAlertNotification(alert, result) {
    let channel;

    try {
      channel = await this.discordClient.channels.fetch(alert.channelId);
    } catch (error) {
      this.logger.warn('alerts.channel_fetch_failed', error, {
        alertId: alert.id,
        channelId: alert.channelId,
        guildId: alert.guildId
      });
      this.alertStore.markAlertSendFailed({
        id: alert.id,
        reason: 'channel_fetch_failed'
      });
      return false;
    }

    if (!channel || !channel.isTextBased?.() || typeof channel.send !== 'function') {
      this.logger.warn('alerts.channel_unavailable', {
        alertId: alert.id,
        channelId: alert.channelId,
        guildId: alert.guildId
      });
      this.alertStore.markAlertSendFailed({
        id: alert.id,
        reason: 'channel_unavailable'
      });
      return false;
    }

    try {
      await channel.send({
        content: result.message,
        allowedMentions: {
          parse: [],
          users: [alert.userId]
        }
      });
      return true;
    } catch (error) {
      this.logger.warn('alerts.notification_send_failed', error, {
        alertId: alert.id,
        channelId: alert.channelId,
        guildId: alert.guildId,
        userId: alert.userId
      });
      this.alertStore.markAlertSendFailed({
        id: alert.id,
        reason: 'notification_send_failed'
      });
      return false;
    }
  }
}

function buildPlannerSettings(alert) {
  const settings = {};

  if (alert.flightType) {
    settings.flightType = alert.flightType;
  }

  if (alert.capacity) {
    settings.capacity = alert.capacity;
  }

  return settings;
}

function buildAvailableAlertMessage(alert, snapshot) {
  const parts = [
    `<@${alert.userId}> Alert: ${alert.itemName} is available in ${alert.country} right now.`
  ];
  const stock = toNumber(snapshot?.countryRow?.stock);

  if (stock !== null) {
    parts.push(`Stock: ${formatCount(stock)}.`);
  }

  return parts.join(' ');
}

function buildFlyoutAlertMessage(alert, run) {
  const parts = [
    `<@${alert.userId}> Fly-out alert: Leave for ${alert.country} now if you want ${alert.itemName} to be in stock on arrival.`
  ];
  const stock = toNumber(run?.stock);
  const windowMinutes = toNumber(run?.availabilityWindowMinutes);

  if (stock !== null) {
    parts.push(`Stock: ${formatCount(stock)}.`);
  }

  if (windowMinutes !== null) {
    parts.push(`Window: ${formatDurationMinutes(windowMinutes)}.`);
  }

  return parts.join(' ');
}

function findMatchingPlannerRun(runs, alert) {
  return (Array.isArray(runs) ? runs : []).find(
    (run) =>
      normalizeKey(run?.itemName) === normalizeKey(alert.itemName) &&
      normalizeKey(run?.country) === normalizeKey(alert.country)
  ) || null;
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
