const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildGiveawayEntryCooldownNoticeContent,
  buildGiveawayAnnouncementContent,
  buildGiveawayEmbed,
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
    maxEntries: 25,
    winnerCooldownEnabled: true,
    winnerCooldownMs: 3 * 60 * 1000
  });
  const fields = embed.data.fields || [];

  assert.match(embed.data.description, /25 entries are reached/);
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
        endMode: 'entries',
        maxEntries: 50,
        status: 'active',
        endAt: null
      }
    ]
  });

  assert.match(embed.data.description, /50 entry goal/);
  assert.match(embed.data.description, /Closes when 50 entries are reached/);
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
