const COMMAND_HELP_ENTRIES = Object.freeze([
  {
    name: '/help',
    value: 'Usage: `/help`\nShows a quick reference for every public command.'
  },
  {
    name: '/run best',
    value: 'Usage: `/run best`\nShows the single best current profitable run from DroqsDB.'
  },
  {
    name: '/run top',
    value: 'Usage: `/run top count:<1-10>`\nShows the top current profitable runs across all countries.'
  },
  {
    name: '/run selltarget',
    value: 'Usage: `/run selltarget target:<market|bazaar|torn> count:<1-10>`\nShows the top current runs for one sell target.'
  },
  {
    name: '/run country',
    value: 'Usage: `/run country country:<country> count:<1-10>`\nShows the best current runs for one country.'
  },
  {
    name: '/run item',
    value: 'Usage: `/run item item:<item name>`\nShows the best current in-stock countries for one item.'
  },
  {
    name: '/run category',
    value: 'Usage: `/run category category:<plushies|flowers|drugs> count:<1-10>`\nShows the best current runs within one tracked category.'
  },
  {
    name: '/price',
    value: 'Usage: `/price item:<item name>`\nShows the latest tracked pricing snapshot for one item.'
  },
  {
    name: '/stock',
    value: 'Usage: `/stock item:<item name> country:<country>`\nChecks whether an item is currently in stock in one country.'
  },
  {
    name: '/restock',
    value: 'Usage: `/restock item:<item name> country:<country>`\nShows the public restock estimate for one item in one country.'
  },
  {
    name: '/alert create',
    value:
      'Usage: `/alert create country:<country> item:<item name> mode:<available|flyout> [repeat:<once|every_time>] [flight_type] [capacity] [note]`\nCreates a one-time or recurring private DM when DroqsDB shows the item is available or ready to fly for.'
  },
  {
    name: '/alert list',
    value: 'Usage: `/alert list`\nShows your active alerts in this server.'
  },
  {
    name: '/alert remove',
    value: 'Usage: `/alert remove id:<alert id>`\nRemoves one of your active alerts.'
  },
  {
    name: '/autopost enable',
    value:
      'Usage: `/autopost enable channel:<channel> [count:<1-10>] [mode] [categories:<csv>] [countries:<csv>]`\nTurns on hourly guild autoposts. Modes: Top N, Flight Groups, Category Groups, Full Breakdown. Requires `Manage Server`.'
  },
  {
    name: '/autopost daily-forecast',
    value:
      'Usage: `/autopost daily-forecast enabled:<true|false> [channel] [time:<HH:mm TCT>] [count:<1-10>]`\nTurns the once-daily DroqsDB Daily Travel Forecast autopost on or off. Requires `Manage Server`.'
  },
  {
    name: '/autopost disable',
    value: 'Usage: `/autopost disable`\nTurns off hourly guild autoposts. Requires `Manage Server`.'
  },
  {
    name: '/autopost status',
    value: 'Usage: `/autopost status`\nShows the current hourly autopost settings for this server.'
  },
  {
    name: '/giveaway status',
    value:
      'Usage: `/giveaway status`\nShows the active giveaway(s) for this server. Public command.'
  },
  {
    name: '/giveaway leaderboard',
    value:
      'Usage: `/giveaway leaderboard`\nShows the all-time giveaway winners for this server. Public command.'
  },
  {
    name: '/giveaway start',
    value:
      'Usage: `/giveaway start item:<text> winners:<1-10> [game_type:<standard|mini game>] [end_mode:<time|entries>] [duration:<15m|2h|1h15m|1d6h>] [max_entries:<1-500>] [winner_cooldown:<true|false>]`\nCreates a reaction-based giveaway in the current channel. Timed giveaways use `duration`. Entry-target giveaways use `max_entries`. Mini-game giveaways auto-resolve and should use `winners:1`. Requires `Manage Server`.'
  },
  {
    name: '/giveaway end',
    value:
      'Usage: `/giveaway end message_id:<id>`\nEnds an active giveaway early and picks winners immediately. Requires `Manage Server`.'
  },
  {
    name: '/giveaway reroll',
    value:
      'Usage: `/giveaway reroll message_id:<id>`\nRerolls winners from the saved entrant list after a giveaway has ended. Requires `Manage Server`.'
  }
]);

module.exports = {
  COMMAND_HELP_ENTRIES
};
