const { PermissionFlagsBits } = require('discord.js');
const {
  buildAutopostStatusEmbed,
  buildInfoEmbed
} = require('../../utils/formatters');
const {
  DEFAULT_AUTOPOST_COUNT,
  formatAutopostFilters,
  formatAutopostMode,
  formatAutopostModeSummary,
  normalizeAutopostMode
} = require('../../utils/autopost');

function assertGuildAdmin(interaction) {
  if (!interaction.inGuild()) {
    throw new Error('This command can only be used inside a server.');
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    throw new Error('You need the Manage Server permission to change autopost settings.');
  }
}

function assertGuildContext(interaction) {
  if (!interaction.inGuild()) {
    throw new Error('This command can only be used inside a server.');
  }
}

function assertSendableChannel(interaction, channel) {
  if (channel.guildId !== interaction.guildId) {
    throw new Error('Please choose a channel from this server.');
  }

  if (!channel.isTextBased() || typeof channel.send !== 'function') {
    throw new Error('That channel is not a text channel I can post embeds into.');
  }

  const permissions =
    typeof channel.permissionsFor === 'function' && interaction.client.user?.id
      ? channel.permissionsFor(interaction.client.user.id)
      : null;
  const missingPermissions = permissions
    ? REQUIRED_CHANNEL_PERMISSIONS.filter((permission) => !permissions.has(permission, true))
    : REQUIRED_CHANNEL_PERMISSIONS.slice();

  if (missingPermissions.length) {
    throw new Error(
      `I cannot post to ${channel}. Missing permissions: ${missingPermissions.map(formatPermissionName).join(', ')}.`
    );
  }
}

async function execute(interaction, context) {
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'status') {
    assertGuildContext(interaction);

    const guildConfig = await context.autopostService.getGuildConfig(interaction.guildId);
    context.logger.info('autopost.status_requested', {
      guildId: interaction.guildId,
      userId: interaction.user.id
    });

    await interaction.reply({
      embeds: [
        buildAutopostStatusEmbed({
          config: guildConfig,
          url: context.config.droqsdbWebBaseUrl
        })
      ],
      ephemeral: true
    });
    return;
  }

  assertGuildAdmin(interaction);

  if (subcommand === 'enable') {
    const channel = interaction.options.getChannel('channel', true);
    const count = interaction.options.getInteger('count') ?? DEFAULT_AUTOPOST_COUNT;
    const mode = normalizeAutopostMode(interaction.options.getString('mode'));
    const category = interaction.options.getString('category');
    const country = interaction.options.getString('country');

    assertSendableChannel(interaction, channel);

    const guildConfig = await context.autopostService.enable({
      guildId: interaction.guildId,
      channelId: channel.id,
      count,
      mode,
      category,
      country,
      updatedBy: interaction.user.id
    });
    context.logger.info('autopost.enabled', {
      category: guildConfig.category,
      channelId: guildConfig.channelId,
      count: guildConfig.count,
      country: guildConfig.country,
      guildId: interaction.guildId,
      mode: guildConfig.mode,
      userId: interaction.user.id
    });

    await interaction.reply({
      embeds: [
        buildInfoEmbed(
          'Autopost Enabled',
          [
            `Hourly DroqsDB autoposts will be sent to ${channel}.`,
            `Mode: ${formatAutopostMode(guildConfig.mode)}`,
            `Mode Details: ${formatAutopostModeSummary(guildConfig)}`,
            `Filters: ${formatAutopostFilters(guildConfig)}`
          ].join('\n'),
          { url: context.config.droqsdbWebBaseUrl }
        )
      ],
      ephemeral: true
    });
    return;
  }

  await context.autopostService.disable({
    guildId: interaction.guildId,
    updatedBy: interaction.user.id
  });
  context.logger.info('autopost.disabled', {
    guildId: interaction.guildId,
    userId: interaction.user.id
  });

  await interaction.reply({
    embeds: [
      buildInfoEmbed(
        'Autopost Disabled',
        'Hourly DroqsDB autoposting has been turned off for this server.',
        { url: context.config.droqsdbWebBaseUrl }
      )
    ],
    ephemeral: true
  });
}

module.exports = {
  execute
};

const REQUIRED_CHANNEL_PERMISSIONS = Object.freeze([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks
]);

function formatPermissionName(permission) {
  switch (permission) {
    case PermissionFlagsBits.ViewChannel:
      return 'ViewChannel';
    case PermissionFlagsBits.SendMessages:
      return 'SendMessages';
    case PermissionFlagsBits.EmbedLinks:
      return 'EmbedLinks';
    default:
      return String(permission);
  }
}
