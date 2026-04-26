const {
  ALERT_MODE_AVAILABLE,
  ALERT_MODE_FLYOUT,
  DEFAULT_MAX_ACTIVE_ALERTS_PER_USER,
  normalizeAlertMode
} = require('../../services/alertStore');
const { buildInfoEmbed } = require('../../utils/formatters');

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
  const flightType = interaction.options.getString('flight_type') || null;
  const capacity = interaction.options.getInteger('capacity');
  const note = interaction.options.getString('note') || null;

  if (context.alertService.countActiveAlertsForUser(interaction.user.id) >= DEFAULT_MAX_ACTIVE_ALERTS_PER_USER) {
    throw new Error(`You already have ${DEFAULT_MAX_ACTIVE_ALERTS_PER_USER} active alerts. Remove one before adding another.`);
  }

  if (mode === ALERT_MODE_FLYOUT && typeof context.droqsdbClient.queryTravelPlanner !== 'function') {
    throw new Error('Fly-out alerts need a DroqsDB travel planner API endpoint before they can be enabled.');
  }

  const snapshot = await context.droqsdbClient.getItemCountrySnapshot(itemInput, countryInput);

  if (!snapshot.countryRow) {
    throw new Error(`${snapshot.item.itemName} is not currently tracked in ${snapshot.country}.`);
  }

  const alert = context.alertService.createAlert({
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    userId: interaction.user.id,
    itemName: snapshot.item.itemName,
    country: snapshot.country,
    mode,
    flightType: mode === ALERT_MODE_FLYOUT ? flightType : null,
    capacity: mode === ALERT_MODE_FLYOUT ? capacity : null,
    note
  });

  context.logger.info('alert.created', {
    alertId: alert.id,
    country: alert.country,
    guildId: alert.guildId,
    itemName: alert.itemName,
    mode: alert.mode,
    userId: alert.userId
  });

  await interaction.editReply({
    embeds: [
      buildInfoEmbed(
        'Alert Created',
        [
          `ID: ${alert.id}`,
          `Mode: ${formatAlertMode(alert.mode)}`,
          `Item: ${alert.itemName}`,
          `Country: ${alert.country}`,
          alert.flightType ? `Flight type: ${alert.flightType}` : null,
          alert.capacity ? `Capacity: ${alert.capacity}` : null,
          'I will ping you once in this channel when it fires.'
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
          ? alerts.map(formatAlertListLine).join('\n')
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

function formatAlertListLine(alert) {
  const parts = [
    `#${alert.id}`,
    formatAlertMode(alert.mode),
    `${alert.itemName} in ${alert.country}`
  ];

  if (alert.flightType) {
    parts.push(alert.flightType);
  }

  if (alert.capacity) {
    parts.push(`capacity ${alert.capacity}`);
  }

  return parts.join(' - ');
}

module.exports = {
  execute
};
