const { PermissionFlagsBits } = require('discord.js');
const { buildInfoEmbed } = require('../../utils/formatters');
const {
  buildGiveawayLeaderboardEmbed,
  buildGiveawayStatusEmbed,
  formatWinnerMentions
} = require('../../utils/giveawayFormatters');
const {
  DEFAULT_GIVEAWAY_WINNER_COOLDOWN_MS,
  GIVEAWAY_END_MODE_ENTRIES,
  GIVEAWAY_END_MODE_TIME,
  formatDurationWords,
  getGiveawayGameTypeLabel,
  isMiniGameGiveawayType,
  normalizeGiveawayEndMode,
  normalizeGiveawayGameType,
  normalizeGiveawayMaxEntries,
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
  const isPublicView = subcommand === 'status' || subcommand === 'leaderboard';

  await interaction.deferReply({
    ephemeral: !isPublicView
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

  if (subcommand === 'leaderboard') {
    const leaderboard = context.giveawayService.getLeaderboard(interaction.guildId, {
      limit: 10
    });
    const leaderboardEntries = await resolveLeaderboardEntries(interaction.guild, leaderboard, {
      logger: context.logger
    });

    context.logger.info('giveaway.leaderboard_requested', {
      guildId: interaction.guildId,
      rankedUserCount: leaderboardEntries.length,
      userId: interaction.user.id
    });

    await interaction.editReply({
      embeds: [
        buildGiveawayLeaderboardEmbed({
          guildName: interaction.guild?.name || null,
          entries: leaderboardEntries
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
    const durationInput = interaction.options.getString('duration');
    const maxEntries = normalizeGiveawayMaxEntries(interaction.options.getInteger('max_entries'));
    const gameType = normalizeGiveawayGameType(
      interaction.options.getString('game_type')
    );
    const endMode = resolveRequestedGiveawayEndMode({
      requestedEndMode: interaction.options.getString('end_mode'),
      durationInput,
      maxEntries
    });
    const duration =
      endMode === GIVEAWAY_END_MODE_TIME
        ? parseRequiredGiveawayDuration(durationInput)
        : null;
    const winnerCooldownEnabled = interaction.options.getBoolean('winner_cooldown') === true;

    if (!item) {
      throw new Error('Prize text cannot be empty.');
    }

    if (isMiniGameGiveawayType(gameType) && winners !== 1) {
      throw new Error('Mini-game giveaways resolve to one winner, so set winners to 1.');
    }

    if (endMode === GIVEAWAY_END_MODE_ENTRIES && !Number.isFinite(maxEntries)) {
      throw new Error('Entry-target giveaways need a max entry count.');
    }

    if (endMode === GIVEAWAY_END_MODE_ENTRIES && maxEntries < winners) {
      throw new Error('Entry target must be at least as large as the winner count.');
    }

    assertGiveawayChannel(interaction, channel);

    const { giveaway, message } = await context.giveawayService.createGiveaway({
      channel,
      hostUser: interaction.user,
      prizeText: item,
      winnerCount: winners,
      durationMs: duration?.durationMs || 0,
      endMode,
      gameType,
      maxEntries,
      winnerCooldownEnabled
    });

    context.logger.info('giveaway.started', {
      channelId: giveaway.channelId,
      durationMs: giveaway.durationMs,
      endMode: giveaway.endMode,
      endAt: giveaway.endAt,
      gameType: giveaway.gameType,
      guildId: giveaway.guildId,
      hostId: giveaway.hostId,
      maxEntries: giveaway.maxEntries,
      messageId: giveaway.messageId,
      winnerCooldownEnabled: giveaway.winnerCooldownEnabled,
      winnerCooldownMs: giveaway.winnerCooldownMs,
      winnerCount: giveaway.winnerCount
    });

    await interaction.editReply({
      embeds: [
        buildInfoEmbed(
          'Boarding Confirmed',
          buildGiveawayStartSummary({
            channel,
            giveaway,
            message
          })
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
        `Game: ${getGiveawayGameTypeLabel(giveaway.gameType)}`,
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
        `Game: ${getGiveawayGameTypeLabel(giveaway.gameType)}`,
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
        `Game: ${getGiveawayGameTypeLabel(giveaway.gameType)}`,
        'The giveaway was marked ended in storage, but I could not reach the original channel or message to confirm entrants.'
      ].join('\n')
    );
  }

  return buildInfoEmbed(
    title,
    [
      `Prize: ${giveaway.prizeText}`,
      `Message ID: ${giveaway.messageId}`,
      `Game: ${getGiveawayGameTypeLabel(giveaway.gameType)}`,
      `Winners: ${formatWinnerMentions(result.winnerIds)}`,
      `Eligible entrants: ${result.entrantCount}`,
      result.gameResult?.summaryLine ? `Resolution: ${result.gameResult.summaryLine}` : null,
      `Message updated: ${result.messageEdited ? 'Yes' : 'No'}`,
      `Announcement sent: ${result.announcementSent ? 'Yes' : 'No'}`
    ].filter(Boolean).join('\n')
  );
}

function resolveRequestedGiveawayEndMode({
  requestedEndMode,
  durationInput,
  maxEntries
}) {
  if (requestedEndMode) {
    return normalizeGiveawayEndMode(requestedEndMode);
  }

  const hasDuration = Boolean(String(durationInput || '').trim());
  const hasMaxEntries = Number.isFinite(maxEntries);

  if (hasDuration && hasMaxEntries) {
    throw new Error(
      'Choose either a duration or a max entry count, or set the end mode explicitly.'
    );
  }

  return hasMaxEntries ? GIVEAWAY_END_MODE_ENTRIES : GIVEAWAY_END_MODE_TIME;
}

function parseRequiredGiveawayDuration(value) {
  const normalized = String(value || '').trim();

  if (!normalized) {
    throw new Error('Timed giveaways need a duration, for example `15m` or `2h`.');
  }

  return parseGiveawayDuration(normalized);
}

function buildGiveawayStartSummary({
  channel,
  giveaway,
  message
}) {
  const lines = [
    `Posted in ${channel}.`,
    `Prize: ${giveaway.prizeText}`,
    `Game: ${getGiveawayGameTypeLabel(giveaway.gameType)}`,
    `Winners: ${giveaway.winnerCount}`,
    giveaway.endMode === GIVEAWAY_END_MODE_ENTRIES
      ? `Mode: Entry target (${giveaway.maxEntries} entries)`
      : 'Mode: Timed',
    giveaway.winnerCooldownEnabled
      ? `Winner cooldown: On (${formatDurationWords(giveaway.winnerCooldownMs || DEFAULT_GIVEAWAY_WINNER_COOLDOWN_MS)})`
      : 'Winner cooldown: Off'
  ];

  if (giveaway.endMode === GIVEAWAY_END_MODE_TIME && giveaway.endAt) {
    lines.push(`Ends: <t:${Math.floor(Date.parse(giveaway.endAt) / 1000)}:F>`);
    lines.push(`Time left: <t:${Math.floor(Date.parse(giveaway.endAt) / 1000)}:R>`);
  }

  lines.push(`Message: ${message.url}`);

  return lines.join('\n');
}

async function resolveLeaderboardEntries(guild, leaderboardEntries, {
  logger = console
} = {}) {
  const resolvedEntries = [];
  const displayLabelCache = new Map();

  for (const entry of Array.isArray(leaderboardEntries) ? leaderboardEntries : []) {
    if (!entry) {
      continue;
    }

    const normalizedUserId = String(entry.userId || '').trim();
    let displayLabel = 'Unknown User';

    if (displayLabelCache.has(normalizedUserId)) {
      displayLabel = displayLabelCache.get(normalizedUserId);
    } else {
      displayLabel = await resolveLeaderboardDisplayLabel(guild, normalizedUserId, {
        logger
      });
      displayLabelCache.set(normalizedUserId, displayLabel);
    }

    resolvedEntries.push({
      ...entry,
      displayLabel
    });
  }

  return resolvedEntries;
}

async function resolveLeaderboardDisplayLabel(guild, userId, {
  logger = console
} = {}) {
  const normalizedUserId = String(userId || '').trim();

  if (!normalizedUserId) {
    return 'Unknown User';
  }

  const cachedMember = guild?.members?.cache?.get?.(normalizedUserId) || null;

  if (cachedMember) {
    return cachedMember.displayName ?? cachedMember.user?.username ?? 'Unknown User';
  }

  if (!guild?.members || typeof guild.members.fetch !== 'function') {
    return 'Unknown User';
  }

  try {
    const member = await guild.members.fetch(normalizedUserId);
    return member?.displayName ?? member?.user?.username ?? 'Unknown User';
  } catch (error) {
    if (!isUnknownMemberError(error)) {
      logger?.warn?.('leaderboard.member_fetch_failed', error, {
        guildId: guild?.id || null,
        messageId: null,
        userId: normalizedUserId
      });
    }

    return 'Unknown User';
  }
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

function isUnknownMemberError(error) {
  return [10007, 10013].includes(Number(error?.code));
}

module.exports = {
  execute
};
