const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildGiveawayAnnouncementContent,
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
