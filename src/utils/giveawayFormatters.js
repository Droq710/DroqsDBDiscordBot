const { EmbedBuilder } = require('discord.js');
const {
  DEFAULT_GIVEAWAY_WINNER_COOLDOWN_MS,
  GIVEAWAY_EMOJI,
  GIVEAWAY_END_MODE_ENTRIES,
  GIVEAWAY_END_MODE_TIME,
  formatDurationWords,
  getGiveawayGameTypeLabel,
  isMiniGameGiveawayType,
  normalizeGiveawayEndMode,
  normalizeGiveawayGameType,
  normalizeGiveawayWinnerCooldownEnabled,
  normalizeGiveawayWinnerCooldownMs
} = require('./giveaway');

const COLORS = Object.freeze({
  info: 0x5865f2,
  success: 0x2ecc71,
  warning: 0xf1c40f
});
const TORN_ID_PATTERN = /\[(\d{4,10})\]/;

function joinCompactParts(parts) {
  return parts.filter(Boolean).join(' | ');
}

function buildGiveawayEmbed({
  prizeText,
  winnerCount,
  hostId,
  endAt,
  status = 'active',
  endMode = GIVEAWAY_END_MODE_TIME,
  gameType = 'standard',
  maxEntries = null,
  winnerIds = [],
  entrantCount = null,
  eligibleEntrantCount = null,
  endedAt = null,
  rerolledAt = null,
  gameSummaryLine = null,
  winnerCooldownEnabled = false,
  winnerCooldownMs = DEFAULT_GIVEAWAY_WINNER_COOLDOWN_MS
}) {
  const isEnded = status === 'ended';
  const normalizedEndMode = normalizeGiveawayEndMode(endMode);
  const normalizedGameType = normalizeGiveawayGameType(gameType);
  const resolvedWinnerIds = normalizeIdList(winnerIds);
  const resolvedEntrantCount = normalizeCount(entrantCount);
  const resolvedEligibleEntrantCount =
    normalizeCount(eligibleEntrantCount) ?? resolvedEntrantCount;
  const title = isEnded ? 'Giveaway Flight Closed' : 'Giveaway Boarding Now';
  const description = isEnded
    ? resolvedWinnerIds.length
      ? `${resolvedWinnerIds.length === 1 ? 'Passenger selected' : 'Passengers selected'}: ${formatWinnerMentions(resolvedWinnerIds)}`
      : 'Flight closed. No eligible passengers were available at departure.'
    : normalizedEndMode === GIVEAWAY_END_MODE_ENTRIES && normalizeCount(maxEntries) !== null
      ? `React with ${GIVEAWAY_EMOJI} on this message to enter. This flight closes when ${formatCount(maxEntries)} entries are reached.`
      : `React with ${GIVEAWAY_EMOJI} on this message to enter.`;
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(isEnded ? COLORS.warning : COLORS.success);
  const resolvedEndedAt = endedAt || endAt;

  embed.addFields(
    {
      name: 'Prize',
      value: truncateText(prizeText, 1024),
      inline: false
    },
    {
      name: 'Mode',
      value:
        normalizedEndMode === GIVEAWAY_END_MODE_ENTRIES
          ? 'Entry target'
          : 'Timed',
      inline: true
    },
    {
      name: 'Game',
      value: getGiveawayGameTypeLabel(normalizedGameType),
      inline: true
    },
    {
      name: 'Winners',
      value: String(Math.max(1, Math.floor(Number(winnerCount) || 1))),
      inline: true
    },
    {
      name: 'Host',
      value: `<@${hostId}>`,
      inline: true
    },
    {
      name: 'Winner Cooldown',
      value: formatWinnerCooldownSetting({
        enabled: winnerCooldownEnabled,
        durationMs: winnerCooldownMs
      }),
      inline: true
    }
  );

  if (normalizedEndMode === GIVEAWAY_END_MODE_ENTRIES && normalizeCount(maxEntries) !== null) {
    embed.addFields({
      name: 'Entry Goal',
      value: `${formatCount(maxEntries)} entries`,
      inline: true
    });
  }

  if (normalizedEndMode === GIVEAWAY_END_MODE_TIME) {
    embed.addFields(
      {
        name: isEnded ? 'Closed' : 'Ends In',
        value: isEnded ? toDiscordTimestamp(resolvedEndedAt, 'R') : toDiscordTimestamp(endAt, 'R'),
        inline: true
      },
      {
        name: isEnded ? 'Closed At' : 'End Time',
        value: toDiscordTimestamp(resolvedEndedAt, 'F'),
        inline: true
      }
    );
  } else if (isEnded) {
    embed.addFields({
      name: 'Closed At',
      value: toDiscordTimestamp(resolvedEndedAt, 'F'),
      inline: true
    });
  }

  if (!isEnded) {
    embed.addFields({
      name: 'How to Enter',
      value: `React with ${GIVEAWAY_EMOJI} on this message.`,
      inline: false
    });
    return embed;
  }

  embed.addFields({
    name: 'Entries',
    value: resolvedEntrantCount === null ? 'Unknown' : formatCount(resolvedEntrantCount),
    inline: true
  });

  if (
    resolvedEligibleEntrantCount !== null &&
    resolvedEntrantCount !== null &&
    resolvedEligibleEntrantCount !== resolvedEntrantCount
  ) {
    embed.addFields({
      name: 'Eligible Now',
      value: formatCount(resolvedEligibleEntrantCount),
      inline: true
    });
  }

  if (
    resolvedEligibleEntrantCount !== null &&
    resolvedEligibleEntrantCount > 0 &&
    resolvedEligibleEntrantCount < winnerCount
  ) {
    const passengerLabel = resolvedEligibleEntrantCount === 1 ? 'passenger remained' : 'passengers remained';

    embed.addFields({
      name: 'Result',
      value: `Only ${formatCount(resolvedEligibleEntrantCount)} eligible ${passengerLabel}, so all eligible passengers won.`,
      inline: false
    });
  }

  if (rerolledAt) {
    embed.addFields({
      name: 'Last Reroll',
      value: formatTimestampPair(rerolledAt),
      inline: false
    });
  }

  if (isMiniGameGiveawayType(normalizedGameType) && gameSummaryLine) {
    embed.addFields({
      name: 'Resolution',
      value: truncateText(gameSummaryLine, 1024),
      inline: false
    });
  }

  return embed;
}

function buildGiveawayAnnouncementContent({
  prizeText,
  gameType = 'standard',
  gameResult = null,
  winnerIds = [],
  winnerProfiles = [],
  entrantCount = 0,
  eligibleEntrantCount = null,
  winnerCount = 1,
  rerolled = false
}) {
  const normalizedGameType = normalizeGiveawayGameType(gameType);
  const resolvedWinnerIds = normalizeIdList(winnerIds);
  const resolvedEligibleEntrantCount =
    normalizeCount(eligibleEntrantCount) ?? normalizeCount(entrantCount) ?? 0;
  const safePrizeText = truncateText(sanitizeMentions(prizeText), 200);
  const statusLabel = rerolled ? 'Passenger manifest updated' : 'Flight closed';
  const gameLines = Array.isArray(gameResult?.detailLines)
    ? gameResult.detailLines.map((detailLine) => String(detailLine || '').trim()).filter(Boolean)
    : [];

  if (isMiniGameGiveawayType(normalizedGameType)) {
    const lines = [
      `${GIVEAWAY_EMOJI} ${statusLabel} for **${safePrizeText}**.`,
      `Mini-game: ${gameResult?.gameLabel || getGiveawayGameTypeLabel(normalizedGameType)}`
    ];

    if (!resolvedWinnerIds.length) {
      lines.push(
        'No eligible passengers were available to finish the mini-game.'
      );
      return lines.join('\n');
    }

    if (gameLines.length) {
      lines.push(...gameLines);
    }

    lines.push(
      `Winner: ${formatWinnerAnnouncementTargets(resolvedWinnerIds, winnerProfiles)}`
    );

    return lines.join('\n');
  }

  if (!resolvedWinnerIds.length) {
    return `${GIVEAWAY_EMOJI} ${statusLabel} for **${safePrizeText}**.\nNo eligible passengers were available${rerolled ? ' for this reroll.' : '.'}`;
  }

  const winnerLabel = resolvedWinnerIds.length === 1 ? 'Passenger selected' : 'Passengers selected';
  const shortageNote =
    resolvedEligibleEntrantCount > 0 && resolvedEligibleEntrantCount < winnerCount
      ? ` Only ${formatCount(resolvedEligibleEntrantCount)} eligible ${resolvedEligibleEntrantCount === 1 ? 'passenger remained' : 'passengers remained'}, so all eligible passengers were selected.`
      : '';

  return `${GIVEAWAY_EMOJI} ${statusLabel} for **${safePrizeText}**.\n${winnerLabel}: ${formatWinnerAnnouncementTargets(
    resolvedWinnerIds,
    winnerProfiles
  )}${shortageNote}`;
}

function buildGiveawayStatusEmbed({
  guildName = null,
  giveaways = []
}) {
  const activeGiveaways = Array.isArray(giveaways) ? giveaways.filter(Boolean) : [];

  if (!activeGiveaways.length) {
    return new EmbedBuilder()
      .setTitle('Giveaway Status')
      .setDescription('No giveaway flights are boarding right now.')
      .setColor(COLORS.info);
  }

  const visibleGiveaways = activeGiveaways.slice(0, 5);
  const embed = new EmbedBuilder()
    .setTitle('Giveaway Status')
    .setDescription(
      [
        guildName
          ? `Active giveaway flights in ${sanitizeMentions(guildName)}:`
          : 'Active giveaway flights here:',
        ...visibleGiveaways.map(formatGiveawayStatusLine)
      ].join('\n\n')
    )
    .setColor(COLORS.success);

  if (activeGiveaways.length > visibleGiveaways.length) {
    embed.setFooter({
      text: `Showing ${visibleGiveaways.length} of ${activeGiveaways.length} active giveaways.`
    });
  }

  return embed;
}

function buildExpiredGiveawayNoticeContent({
  prizeText,
  guildName = null,
  compact = false
}) {
  const safePrizeText = truncateText(sanitizeMentions(prizeText), 120);
  const locationLine = guildName
    ? `That giveaway flight has already closed in **${sanitizeMentions(guildName)}**.`
    : 'That giveaway flight has already closed here.';

  if (compact) {
    return `${locationLine} I removed your reaction. Prize: **${safePrizeText}**`;
  }

  return [
    locationLine,
    `Prize: **${safePrizeText}**`,
    'I removed your reaction so the entry lane stays accurate.'
  ].join('\n');
}

function buildGiveawayEntryCooldownNoticeContent({
  prizeText,
  guildName = null,
  cooldownLabel,
  compact = false
}) {
  const safePrizeText = truncateText(sanitizeMentions(prizeText), 120);
  const locationLine = guildName
    ? `That giveaway in **${sanitizeMentions(guildName)}** has a recent-winner cooldown.`
    : 'That giveaway has a recent-winner cooldown.';

  if (compact) {
    return `${locationLine} I removed your reaction. You can try again in about **${cooldownLabel}**. Prize: **${safePrizeText}**`;
  }

  return [
    locationLine,
    `Prize: **${safePrizeText}**`,
    `I removed your reaction this time. You can enter again in about **${cooldownLabel}**.`
  ].join('\n');
}

function formatWinnerMentions(winnerIds) {
  const resolvedWinnerIds = normalizeIdList(winnerIds);
  return resolvedWinnerIds.length
    ? resolvedWinnerIds.map((winnerId) => `<@${winnerId}>`).join(', ')
    : 'No winners';
}

function formatWinnerAnnouncementTargets(winnerIds, winnerProfiles = []) {
  const resolvedWinnerIds = normalizeIdList(winnerIds);
  const profileMap = new Map(
    (Array.isArray(winnerProfiles) ? winnerProfiles : [])
      .filter((entry) => entry?.winnerId && entry?.profileUrl)
      .map((entry) => [String(entry.winnerId), entry.profileUrl])
  );

  return resolvedWinnerIds.length
    ? resolvedWinnerIds
        .map((winnerId) => {
          const profileUrl = profileMap.get(String(winnerId));
          return profileUrl ? `<@${winnerId}> (${profileUrl})` : `<@${winnerId}>`;
        })
        .join(', ')
    : 'No winners';
}

function formatGiveawayStatusLine(giveaway) {
  const normalizedEndMode = normalizeGiveawayEndMode(giveaway?.endMode);
  const normalizedGameType = normalizeGiveawayGameType(giveaway?.gameType);
  const isClosingNow =
    giveaway.status === 'ending' || isPastTimestamp(giveaway.endAt);
  const scheduleLabel = isClosingNow
    ? 'Closing now'
    : normalizedEndMode === GIVEAWAY_END_MODE_ENTRIES && normalizeCount(giveaway.maxEntries) !== null
      ? `Closes when ${formatCount(giveaway.maxEntries)} entries are reached`
      : `Ends ${toDiscordTimestamp(giveaway.endAt, 'R')} (${toDiscordTimestamp(giveaway.endAt, 'F')})`;

  return [
    `**${truncateText(sanitizeMentions(giveaway.prizeText), 80)}**`,
    joinCompactParts([
      `<#${giveaway.channelId}>`,
      `${formatCount(giveaway.winnerCount)} winner(s)`,
      getGiveawayGameTypeLabel(normalizedGameType),
      normalizedEndMode === GIVEAWAY_END_MODE_ENTRIES && normalizeCount(giveaway.maxEntries) !== null
        ? `${formatCount(giveaway.maxEntries)} entry goal`
        : 'Timed'
    ]),
    scheduleLabel
  ].join('\n');
}

function formatWinnerCooldownSetting({
  enabled,
  durationMs
}) {
  if (!normalizeGiveawayWinnerCooldownEnabled(enabled)) {
    return 'Off';
  }

  return `On (${formatDurationWords(normalizeGiveawayWinnerCooldownMs(durationMs))})`;
}

function formatCount(value) {
  const numeric = Number(value);

  if (!Number.isFinite(numeric)) {
    return 'N/A';
  }

  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 0
  }).format(numeric);
}

function formatTimestampPair(value) {
  return `${toDiscordTimestamp(value, 'F')} (${toDiscordTimestamp(value, 'R')})`;
}

function toDiscordTimestamp(value, style = 'R') {
  const timestamp = Date.parse(value || '');

  if (!Number.isFinite(timestamp)) {
    return 'Unknown';
  }

  return `<t:${Math.floor(timestamp / 1000)}:${style}>`;
}

function truncateText(value, maxLength = 1024) {
  const normalized = String(value || '').trim() || 'Unavailable';

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function sanitizeMentions(value) {
  return String(value || '').replace(/@/g, '@\u200b');
}

function extractTornIdFromText(value) {
  const match = String(value || '').match(TORN_ID_PATTERN);
  return match ? match[1] : null;
}

function normalizeIdList(value) {
  return Array.from(
    new Set(
      Array.isArray(value)
        ? value
            .map((entry) => String(entry || '').trim())
            .filter(Boolean)
        : []
    )
  );
}

function normalizeCount(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : null;
}

function isPastTimestamp(value) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) && timestamp <= Date.now();
}

module.exports = {
  buildGiveawayEntryCooldownNoticeContent,
  buildExpiredGiveawayNoticeContent,
  buildGiveawayAnnouncementContent,
  buildGiveawayEmbed,
  buildGiveawayStatusEmbed,
  extractTornIdFromText,
  formatWinnerMentions
};
