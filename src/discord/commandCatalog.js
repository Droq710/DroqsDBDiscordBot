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
    name: '/autopost enable',
    value: 'Usage: `/autopost enable channel:<channel> [count] [category] [country]`\nTurns on hourly guild autoposts. Requires `Manage Server`.'
  },
  {
    name: '/autopost disable',
    value: 'Usage: `/autopost disable`\nTurns off hourly guild autoposts. Requires `Manage Server`.'
  },
  {
    name: '/autopost status',
    value: 'Usage: `/autopost status`\nShows the current hourly autopost settings for this server.'
  }
]);

module.exports = {
  COMMAND_HELP_ENTRIES
};
