const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildGiveawayEntryCooldownNoticeContent,
  buildGiveawayAnnouncementContent,
  buildGiveawayEmbed,
  buildGiveawayLeaderboardEmbed,
  buildGiveawayStatusEmbed,
  extractTornIdFromText
} = require('../src/utils/giveawayFormatters');

test('extractTornIdFromText reads bracketed Torn IDs from Discord-visible names', () => {
  assert.equal(extractTornIdFromText('Winner Name [1234567]'), '1234567');
  assert.equal(extractTornIdFromText('Winner Name'), null);
});

test('giveaway announcements include Torn profile links when provided', () => {
  const content = buildGiveawayAnnouncementContent({
    prizeText: '2x Xanax',
    winnerIds: ['111'],
    winnerProfiles: [
      {
        winnerId: '111',
        profileUrl: 'https://www.torn.com/profiles.php?XID=1234567'
      }
    ],
    entrantCount: 5,
    eligibleEntrantCount: 5,
    winnerCount: 1
  });

  assert.match(content, /<@111> \(https:\/\/www\.torn\.com\/profiles\.php\?XID=1234567\)/);
});

test('entry-target giveaway embeds show entry goal and cooldown setting', () => {
  const embed = buildGiveawayEmbed({
    prizeText: '2x Xanax',
    winnerCount: 1,
    hostId: '999',
    status: 'active',
    endMode: 'entries',
    gameType: 'dice_duel',
    maxEntries: 25,
    winnerCooldownEnabled: true,
    winnerCooldownMs: 3 * 60 * 1000
  });
  const fields = embed.data.fields || [];

  assert.match(embed.data.description, /25 entries are reached/);
  assert.deepEqual(
    fields.find((field) => field.name === 'Game'),
    {
      name: 'Game',
      value: 'Dice Duel',
      inline: true
    }
  );
  assert.deepEqual(
    fields.find((field) => field.name === 'Entry Goal'),
    {
      name: 'Entry Goal',
      value: '25 entries',
      inline: true
    }
  );
  assert.deepEqual(
    fields.find((field) => field.name === 'Winner Cooldown'),
    {
      name: 'Winner Cooldown',
      value: 'On (3 minutes)',
      inline: true
    }
  );
});

test('giveaway status shows entry-target closing rule', () => {
  const embed = buildGiveawayStatusEmbed({
    giveaways: [
      {
        prizeText: 'Rare Plushie',
        channelId: '123',
        winnerCount: 2,
        gameType: 'coin_flip_battle',
        endMode: 'entries',
        maxEntries: 50,
        status: 'active',
        endAt: null
      }
    ]
  });

  assert.match(embed.data.description, /50 entry goal/);
  assert.match(embed.data.description, /Coin Flip Battle/);
  assert.match(embed.data.description, /Closes when 50 entries are reached/);
});

test('giveaway leaderboard embed formats ranked winners cleanly', () => {
  const embed = buildGiveawayLeaderboardEmbed({
    guildName: 'DroqsDB',
    entries: [
      {
        userId: '111',
        displayLabel: 'UserA',
        winCount: 7
      },
      {
        userId: '222',
        storedLabel: 'UserB',
        winCount: 5
      }
    ]
  });

  assert.match(embed.data.description, /All-time giveaway winners in DroqsDB/);
  assert.match(embed.data.description, /1\. UserA - 7 wins/);
  assert.match(embed.data.description, /2\. UserB - 5 wins/);
});

test('giveaway leaderboard embed falls back to username and wins', () => {
  const embed = buildGiveawayLeaderboardEmbed({
    entries: [
      {
        userId: '111',
        username: 'Droq',
        wins: 3
      },
      {
        userId: '222',
        wins: 2
      },
      {
        wins: 1
      }
    ]
  });

  assert.match(embed.data.description, /1\. Droq - 3 wins/);
  assert.match(embed.data.description, /2\. User 222 - 2 wins/);
  assert.match(embed.data.description, /3\. Unknown User - 1 win/);
});

test('mini-game giveaway announcements include the narrated game result', () => {
  const content = buildGiveawayAnnouncementContent({
    prizeText: '2x Xanax',
    gameType: 'russian_roulette_standard',
    gameResult: {
      gameLabel: 'Russian Roulette',
      detailLines: [
        'Players: <@111> vs <@222>',
        '1. <@111> pulls the trigger... click.',
        '2. <@222> pulls the trigger... BANG.'
      ]
    },
    winnerIds: ['111'],
    entrantCount: 8,
    eligibleEntrantCount: 8,
    winnerCount: 1
  });

  assert.match(content, /Mini-game: Russian Roulette/);
  assert.match(content, /Players: <@111> vs <@222>/);
  assert.match(content, /Winner: <@111>/);
});

test('cooldown notices include the remaining wait time', () => {
  const content = buildGiveawayEntryCooldownNoticeContent({
    prizeText: '2x Xanax',
    guildName: 'DroqsDB',
    cooldownLabel: '2 minutes'
  });

  assert.match(content, /recent-winner cooldown/);
  assert.match(content, /2 minutes/);
});
