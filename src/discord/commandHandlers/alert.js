const {
  ALERT_MODE_AVAILABLE,
  ALERT_MODE_FLYOUT,
  ALERT_REPEAT_EVERY_TIME,
  DEFAULT_MAX_ACTIVE_ALERTS_PER_USER,
  normalizeAlertMode,
  normalizeAlertRepeatMode
} = require('../../services/alertStore');
const { buildInfoEmbed } = require('../../utils/formatters');

const MIN_ALERT_CAPACITY = 1;
const MAX_ALERT_CAPACITY = 100;

async function execute(interaction, context) {
  assertGuildContext(interaction);

  const subcommand = interaction.options.getSubcommand();
  await interaction.deferReply({
    ephemeral: true
  });

  if (subcommand === 'create') {
    await createAlert(interaction, context);
    return;
  }

  if (subcommand === 'list') {
    await listAlerts(interaction, context);
    return;
  }

  await removeAlert(interaction, context);
}

async function createAlert(interaction, context) {
  const itemInput = interaction.options.getString('item', true);
  const countryInput = interaction.options.getString('country', true);
  const mode = normalizeAlertMode(interaction.options.getString('mode', true));
  const repeatMode = normalizeAlertRepeatMode(interaction.options.getString('repeat'));
  const flightType = interaction.options.getString('flight_type') || null;
  const capacity = normalizeCapacityOption(interaction.options.getInteger('capacity'));
  const note = interaction.options.getString('note') || null;

  if (context.alertService.countActiveAlertsForUser(interaction.user.id) >= DEFAULT_MAX_ACTIVE_ALERTS_PER_USER) {
    throw new Error(`You already have ${DEFAULT_MAX_ACTIVE_ALERTS_PER_USER} active alerts. Remove one before adding another.`);
  }

  if (typeof context.droqsdbClient.queryAlertPreview !== 'function') {
    throw new Error('Alerts need the DroqsDB alert preview API endpoint before they can be enabled.');
  }

  const snapshot = await context.droqsdbClient.getItemCountrySnapshot(itemInput, countryInput);

  if (!snapshot.countryRow) {
    throw new Error(`${snapshot.item.itemName} is not currently tracked in ${snapshot.country}.`);
  }

  const settings = resolveAlertPreviewSettings(context, {
    flightType,
    capacity
  });
  const alert = context.alertService.createAlert({
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    userId: interaction.user.id,
    itemName: snapshot.item.itemName,
    country: snapshot.country,
    mode,
    repeatMode,
    flightType: settings.flightType,
    capacity: settings.capacity,
    sellTarget: settings.sellTarget,
    marketTax: settings.marketTax,
    note,
    lastConditionState:
      repeatMode === ALERT_REPEAT_EVERY_TIME && mode === ALERT_MODE_AVAILABLE
        ? isSnapshotAvailable(snapshot)
        : null
  });

  context.logger.info('alert.created', {
    alertId: alert.id,
    country: alert.country,
    guildId: alert.guildId,
    itemName: alert.itemName,
    mode: alert.mode,
    repeatMode: alert.repeatMode,
    flightType: alert.flightType,
    capacity: alert.capacity,
    userId: alert.userId
  });

  await interaction.editReply({
    embeds: [
      buildInfoEmbed(
        'Alert Created',
        [
          `ID: ${alert.id}`,
          `Mode: ${formatAlertMode(alert.mode)}`,
          `Repeat: ${formatAlertRepeatMode(alert.repeatMode)}`,
          `Item: ${alert.itemName}`,
          `Country: ${alert.country}`,
          alert.flightType ? `Flight: ${formatFlightType(alert.flightType)}` : null,
          alert.capacity ? `Capacity: ${alert.capacity}` : null,
          formatAlertCreateSummary(alert)
        ].filter(Boolean).join('\n')
      )
    ]
  });
}

async function listAlerts(interaction, context) {
  const alerts = context.alertService.listUserAlerts({
    guildId: interaction.guildId,
    userId: interaction.user.id
  });

  await interaction.editReply({
    embeds: [
      buildInfoEmbed(
        'Your Alerts',
        alerts.length
          ? alerts.map((alert) => formatAlertListLine(alert, context)).join('\n')
          : 'You do not have any active alerts in this server.'
      )
    ]
  });
}

async function removeAlert(interaction, context) {
  const id = interaction.options.getInteger('id', true);
  const removed = context.alertService.removeUserAlert({
    id,
    guildId: interaction.guildId,
    userId: interaction.user.id,
    reason: 'user_removed'
  });

  if (!removed) {
    throw new Error('No active alert was found for that ID.');
  }

  context.logger.info('alert.removed', {
    alertId: id,
    guildId: interaction.guildId,
    userId: interaction.user.id
  });

  await interaction.editReply({
    embeds: [
      buildInfoEmbed('Alert Removed', `Alert ${id} has been removed.`)
    ]
  });
}

function assertGuildContext(interaction) {
  if (!interaction.inGuild()) {
    throw new Error('This command can only be used inside a server.');
  }
}

function formatAlertMode(mode) {
  return mode === ALERT_MODE_FLYOUT ? 'Fly-out' : 'Available now';
}

function formatAlertListMode(mode) {
  return mode === ALERT_MODE_FLYOUT ? 'Fly-out' : 'Available';
}

function formatAlertRepeatMode(repeatMode) {
  return normalizeAlertRepeatMode(repeatMode) === ALERT_REPEAT_EVERY_TIME ? 'Every time' : 'Once';
}

function formatAlertCreateSummary(alert) {
  if (normalizeAlertRepeatMode(alert.repeatMode) !== ALERT_REPEAT_EVERY_TIME) {
    return 'I will DM you once when it fires. Make sure DMs from this server are enabled.';
  }

  if (alert.mode === ALERT_MODE_FLYOUT) {
    return 'I will DM you every time this run becomes ready to fly. Make sure DMs from this server are enabled.';
  }

  return 'I will DM you every time it comes back in stock. Make sure DMs from this server are enabled.';
}

function formatAlertListLine(alert, context = {}) {
  const settings = resolveAlertPreviewSettings(context, alert);
  const parts = [
    `#${alert.id}`,
    `${alert.itemName} / ${alert.country}`,
    formatAlertListMode(alert.mode),
    formatAlertRepeatMode(alert.repeatMode),
    settings.flightType ? formatFlightType(settings.flightType) : null,
    settings.capacity ? `Cap ${settings.capacity}` : null
  ];

  return parts.filter(Boolean).join(' / ');
}

function isSnapshotAvailable(snapshot) {
  const stock = Number(snapshot?.countryRow?.stock);
  return Number.isFinite(stock) && stock > 0;
}

function resolveAlertPreviewSettings(context, overrides = {}) {
  const source = overrides && typeof overrides === 'object' ? overrides : {};

  if (typeof context.droqsdbClient?.getBotAlertPreviewSettings === 'function') {
    return context.droqsdbClient.getBotAlertPreviewSettings({
      flightType: source.flightType || undefined,
      capacity: source.capacity || undefined,
      sellTarget: source.sellTarget || undefined,
      marketTax: typeof source.marketTax === 'boolean' ? source.marketTax : undefined
    });
  }

  return {
    flightType: source.flightType || null,
    capacity: source.capacity || null,
    sellTarget: source.sellTarget || null,
    marketTax: typeof source.marketTax === 'boolean' ? source.marketTax : null
  };
}

function normalizeCapacityOption(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (!Number.isInteger(value) || value < MIN_ALERT_CAPACITY || value > MAX_ALERT_CAPACITY) {
    throw new Error(`Capacity must be a whole number from ${MIN_ALERT_CAPACITY} to ${MAX_ALERT_CAPACITY}.`);
  }

  return value;
}

function formatFlightType(value) {
  const normalized = String(value || '').trim();

  if (!normalized) {
    return null;
  }

  return normalized
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

module.exports = {
  execute
};
