const { PermissionFlagsBits } = require('discord.js');
const { buildInfoEmbed } = require('../../utils/formatters');
const {
  buildGiveawayStatusEmbed,
  formatWinnerMentions
} = require('../../utils/giveawayFormatters');
const {
  normalizeGiveawayMessageId,
  parseGiveawayDuration
} = require('../../utils/giveaway');

const REQUIRED_GIVEAWAY_CHANNEL_PERMISSIONS = Object.freeze([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AddReactions,
  PermissionFlagsBits.ReadMessageHistory
]);

async function execute(interaction, context) {
  assertGuildContext(interaction);

  const subcommand = interaction.options.getSubcommand();
  const isPublicStatus = subcommand === 'status';

  await interaction.deferReply({
    ephemeral: !isPublicStatus
  });

  if (subcommand === 'status') {
    const giveaways = context.giveawayService.listActiveGiveawaysByGuild(interaction.guildId);

    context.logger.info('giveaway.status_requested', {
      activeGiveawayCount: giveaways.length,
      guildId: interaction.guildId,
      userId: interaction.user.id
    });

    await interaction.editReply({
      embeds: [
        buildGiveawayStatusEmbed({
          guildName: interaction.guild?.name || null,
          giveaways
        })
      ]
    });
    return;
  }

  assertGuildAdmin(interaction);

  if (subcommand === 'start') {
    const channel = interaction.channel;
    const item = interaction.options.getString('item', true).trim();
    const winners = interaction.options.getInteger('winners', true);
    const durationInput = interaction.options.getString('duration', true);
    const duration = parseGiveawayDuration(durationInput);

    if (!item) {
      throw new Error('Prize text cannot be empty.');
    }

    assertGiveawayChannel(interaction, channel);

    const { giveaway, message } = await context.giveawayService.createGiveaway({
      channel,
      hostUser: interaction.user,
      prizeText: item,
      winnerCount: winners,
      durationMs: duration.durationMs
    });

    context.logger.info('giveaway.started', {
      channelId: giveaway.channelId,
      durationMs: giveaway.durationMs,
      endAt: giveaway.endAt,
      guildId: giveaway.guildId,
      hostId: giveaway.hostId,
      messageId: giveaway.messageId,
      winnerCount: giveaway.winnerCount
    });

    await interaction.editReply({
      embeds: [
        buildInfoEmbed(
          'Boarding Confirmed',
          [
            `Posted in ${channel}.`,
            `Prize: ${giveaway.prizeText}`,
            `Winners: ${giveaway.winnerCount}`,
            `Ends: <t:${Math.floor(Date.parse(giveaway.endAt) / 1000)}:F>`,
            `Time left: <t:${Math.floor(Date.parse(giveaway.endAt) / 1000)}:R>`,
            `Message: ${message.url}`
          ].join('\n')
        )
      ]
    });
    return;
  }

  if (subcommand === 'end') {
    const messageId = normalizeGiveawayMessageId(
      interaction.options.getString('message_id', true)
    );
    const giveaway = assertManagedGiveawayGuild(
      interaction,
      context.giveawayService.getGiveaway(messageId)
    );
    const result = await context.giveawayService.endGiveawayByMessageId(messageId, {
      initiatedBy: interaction.user.id
    });

    context.logger.info('giveaway.end_requested', {
      guildId: interaction.guildId,
      messageId,
      userId: interaction.user.id
    });

    await interaction.editReply({
      embeds: [buildGiveawayAdminResultEmbed('Flight Closed', giveaway, result)]
    });
    return;
  }

  const messageId = normalizeGiveawayMessageId(
    interaction.options.getString('message_id', true)
  );
  const giveaway = assertManagedGiveawayGuild(
    interaction,
    context.giveawayService.getGiveaway(messageId)
  );
  const result = await context.giveawayService.rerollGiveawayByMessageId(messageId, {
    rerolledBy: interaction.user.id
  });

  context.logger.info('giveaway.reroll_requested', {
    guildId: interaction.guildId,
    messageId,
    userId: interaction.user.id
  });

  await interaction.editReply({
    embeds: [buildGiveawayAdminResultEmbed('Passengers Updated', giveaway, result)]
  });
}

function assertGuildContext(interaction) {
  if (!interaction.inGuild()) {
    throw new Error('This command can only be used inside a server.');
  }
}

function assertGuildAdmin(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    throw new Error('You need the Manage Server permission to manage giveaways.');
  }
}

function assertGiveawayChannel(interaction, channel) {
  if (!channel || !channel.isTextBased() || typeof channel.send !== 'function') {
    throw new Error('This channel cannot host a giveaway message.');
  }

  const permissions =
    typeof channel.permissionsFor === 'function' && interaction.client.user?.id
      ? channel.permissionsFor(interaction.client.user.id)
      : null;
  const missingPermissions = permissions
    ? REQUIRED_GIVEAWAY_CHANNEL_PERMISSIONS.filter((permission) => !permissions.has(permission, true))
    : REQUIRED_GIVEAWAY_CHANNEL_PERMISSIONS.slice();

  if (missingPermissions.length) {
    throw new Error(
      `I cannot start a giveaway here. Missing permissions: ${missingPermissions.map(formatPermissionName).join(', ')}.`
    );
  }
}

function assertManagedGiveawayGuild(interaction, giveaway) {
  if (!giveaway) {
    throw new Error('No giveaway was found for that message ID.');
  }

  if (giveaway.guildId !== interaction.guildId) {
    throw new Error('That giveaway belongs to a different server.');
  }

  return giveaway;
}

function buildGiveawayAdminResultEmbed(title, giveaway, result) {
  if (result.outcome === 'already_ended') {
    return buildInfoEmbed(
      title,
      [
        'That giveaway was already closed.',
        `Prize: ${giveaway.prizeText}`,
        `Message ID: ${giveaway.messageId}`,
        `Winners: ${formatWinnerMentions(result.winnerIds)}`,
        `Eligible entrants: ${result.entrantCount}`
      ].join('\n')
    );
  }

  if (result.outcome === 'already_processing') {
    return buildInfoEmbed(
      title,
      'That giveaway is already closing. Please give it a moment and try again if needed.'
    );
  }

  if (result.outcome === 'no_entrants') {
    return buildInfoEmbed(
      title,
      [
        `Prize: ${giveaway.prizeText}`,
        `Message ID: ${giveaway.messageId}`,
        'There were no saved eligible entrants available to reroll.'
      ].join('\n')
    );
  }

  if (result.outcome === 'ended_without_access') {
    return buildInfoEmbed(
      title,
      [
        `Prize: ${giveaway.prizeText}`,
        `Message ID: ${giveaway.messageId}`,
        'The giveaway was marked ended in storage, but I could not reach the original channel or message to confirm entrants.'
      ].join('\n')
    );
  }

  return buildInfoEmbed(
    title,
    [
      `Prize: ${giveaway.prizeText}`,
      `Message ID: ${giveaway.messageId}`,
      `Winners: ${formatWinnerMentions(result.winnerIds)}`,
      `Eligible entrants: ${result.entrantCount}`,
      `Message updated: ${result.messageEdited ? 'Yes' : 'No'}`,
      `Announcement sent: ${result.announcementSent ? 'Yes' : 'No'}`
    ].join('\n')
  );
}

function formatPermissionName(permission) {
  switch (permission) {
    case PermissionFlagsBits.ViewChannel:
      return 'ViewChannel';
    case PermissionFlagsBits.SendMessages:
      return 'SendMessages';
    case PermissionFlagsBits.EmbedLinks:
      return 'EmbedLinks';
    case PermissionFlagsBits.AddReactions:
      return 'AddReactions';
    case PermissionFlagsBits.ReadMessageHistory:
      return 'ReadMessageHistory';
    default:
      return String(permission);
  }
}

module.exports = {
  execute
};
