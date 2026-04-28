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
  normalizeAutopostMode,
  parseAutopostCategoryInput,
  parseAutopostCountryInput
} = require('../../utils/autopost');
const {
  DEFAULT_DAILY_FORECAST_COUNT,
  DEFAULT_DAILY_FORECAST_TIME,
  normalizeDailyForecastCount,
  parseDailyForecastTime
} = require('../../utils/dailyForecast');

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
    const categoryInput =
      interaction.options.getString('categories') ?? interaction.options.getString('category');
    const countryInput =
      interaction.options.getString('countries') ?? interaction.options.getString('country');
    const categories = parseAutopostCategoryInput(categoryInput).values;
    const countries = parseAutopostCountryInput(countryInput).values;

    assertSendableChannel(interaction, channel);

    const guildConfig = await context.autopostService.enable({
      guildId: interaction.guildId,
      channelId: channel.id,
      count,
      mode,
      categories,
      countries,
      updatedBy: interaction.user.id
    });
    context.logger.info('autopost.enabled', {
      categories: guildConfig.categories,
      channelId: guildConfig.channelId,
      count: guildConfig.count,
      countries: guildConfig.countries,
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

  if (subcommand === 'daily-forecast') {
    const enabled = interaction.options.getBoolean('enabled', true);
    const existingConfig = await context.autopostService.getGuildConfig(interaction.guildId);

    if (!enabled) {
      const guildConfig = await context.autopostService.disableDailyForecast({
        guildId: interaction.guildId,
        updatedBy: interaction.user.id
      });
      context.logger.info('daily_forecast.disabled', {
        guildId: interaction.guildId,
        userId: interaction.user.id
      });

      await interaction.reply({
        embeds: [
          buildInfoEmbed(
            'Daily Forecast Disabled',
            'DroqsDB Daily Travel Forecast autoposting has been turned off for this server.',
            { url: context.config.droqsdbWebBaseUrl }
          )
        ],
        ephemeral: true
      });
      return guildConfig;
    }

    const channel = interaction.options.getChannel('channel') || null;
    const channelId = channel?.id || existingConfig?.dailyForecastChannelId || null;
    const timeInput = interaction.options.getString('time');
    const time = timeInput
      ? parseDailyForecastTime(timeInput)
      : existingConfig?.dailyForecastTime || DEFAULT_DAILY_FORECAST_TIME;
    const count = normalizeDailyForecastCount(
      interaction.options.getInteger('count') ?? existingConfig?.dailyForecastCount,
      DEFAULT_DAILY_FORECAST_COUNT
    );

    if (!channelId) {
      throw new Error('Choose a channel the first time you enable the daily forecast.');
    }

    if (channel) {
      assertSendableChannel(interaction, channel);
    }

    const guildConfig = await context.autopostService.enableDailyForecast({
      guildId: interaction.guildId,
      channelId,
      time,
      count,
      updatedBy: interaction.user.id
    });
    context.logger.info('daily_forecast.enabled', {
      channelId: guildConfig.dailyForecastChannelId,
      count: guildConfig.dailyForecastCount,
      guildId: interaction.guildId,
      postTime: guildConfig.dailyForecastTime,
      userId: interaction.user.id
    });

    await interaction.reply({
      embeds: [
        buildInfoEmbed(
          'Daily Forecast Enabled',
          [
            `DroqsDB Daily Travel Forecast posts will be sent to <#${guildConfig.dailyForecastChannelId}>.`,
            `Post Time: ${guildConfig.dailyForecastTime} TCT`,
            `Count: ${guildConfig.dailyForecastCount}`
          ].join('\n'),
          { url: context.config.droqsdbWebBaseUrl }
        )
      ],
      ephemeral: true
    });
    return guildConfig;
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
