const {
  ChannelType,
  REST,
  Routes,
  SlashCommandBuilder
} = require('discord.js');
const { assertBotConfig, config } = require('../config');
const { COUNTRY_CHOICES, RUN_CATEGORY_CHOICES } = require('../constants/droqsdb');
const { createLogger } = require('../services/logger');
const {
  AUTOPOST_MODE_CHOICES,
  DEFAULT_AUTOPOST_COUNT,
  MAX_AUTOPOST_COUNT,
  MIN_AUTOPOST_COUNT
} = require('../utils/autopost');
const {
  DEFAULT_DAILY_FORECAST_COUNT,
  DEFAULT_DAILY_FORECAST_TIME,
  MAX_DAILY_FORECAST_COUNT,
  MIN_DAILY_FORECAST_COUNT
} = require('../utils/dailyForecast');
const { GIVEAWAY_GAME_TYPE_CHOICES } = require('../utils/giveaway');

const logger = createLogger({
  level: config.logLevel,
  context: {
    component: 'register_commands'
  }
});

const RUN_SELL_TARGET_CHOICES = Object.freeze([
  { name: 'Market', value: 'market' },
  { name: 'Bazaar', value: 'bazaar' },
  { name: 'Torn City Shops', value: 'torn' }
]);
const ALERT_MODE_CHOICES = Object.freeze([
  { name: 'Available Now', value: 'available' },
  { name: 'Fly Out', value: 'flyout' }
]);
const ALERT_REPEAT_CHOICES = Object.freeze([
  { name: 'One-time ping', value: 'once' },
  { name: 'Every time', value: 'every_time' }
]);
const FLIGHT_TYPE_CHOICES = Object.freeze([
  { name: 'Private', value: 'private' },
  { name: 'Standard', value: 'standard' }
]);

function withCountryChoices(option) {
  for (const country of COUNTRY_CHOICES) {
    option.addChoices({
      name: country,
      value: country
    });
  }

  return option;
}

function buildCommands() {
  return [
    new SlashCommandBuilder()
      .setName('help')
      .setDescription('Show usage help, command examples, and public bot notes.'),

    new SlashCommandBuilder()
      .setName('run')
      .setDescription('Show current profitable DroqsDB travel runs.')
      .addSubcommand((subcommand) =>
        subcommand.setName('best').setDescription('Show the current best run.')
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('top')
          .setDescription('Show the current top profitable runs.')
          .addIntegerOption((option) =>
            option
              .setName('count')
              .setDescription('How many runs to show.')
              .setRequired(true)
              .setMinValue(1)
              .setMaxValue(10)
          )
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('selltarget')
          .setDescription('Show the top current profitable runs for one sell target.')
          .addStringOption((option) =>
            option
              .setName('target')
              .setDescription('Where you plan to sell the items.')
              .setRequired(true)
              .addChoices(...RUN_SELL_TARGET_CHOICES)
          )
          .addIntegerOption((option) =>
            option
              .setName('count')
              .setDescription('How many runs to show.')
              .setRequired(true)
              .setMinValue(1)
              .setMaxValue(10)
          )
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('country')
          .setDescription('Show the top current runs for one country.')
          .addStringOption((option) =>
            withCountryChoices(
              option
                .setName('country')
                .setDescription('Country to inspect.')
                .setRequired(true)
            )
          )
          .addIntegerOption((option) =>
            option
              .setName('count')
              .setDescription('How many runs to show.')
              .setRequired(true)
              .setMinValue(1)
              .setMaxValue(10)
          )
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('item')
          .setDescription('Show the best currently relevant run(s) for one item.')
          .addStringOption((option) =>
            option
              .setName('item')
              .setDescription('Item name.')
              .setRequired(true)
              .setAutocomplete(true)
          )
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('category')
          .setDescription('Show the top current runs for plushies, flowers, or drugs.')
          .addStringOption((option) =>
            option
              .setName('category')
              .setDescription('Category to inspect.')
              .setRequired(true)
              .addChoices(...RUN_CATEGORY_CHOICES)
          )
          .addIntegerOption((option) =>
            option
              .setName('count')
              .setDescription('How many runs to show.')
              .setRequired(true)
              .setMinValue(1)
              .setMaxValue(10)
          )
      ),

    new SlashCommandBuilder()
      .setName('price')
      .setDescription('Show the current DroqsDB price snapshot for an item.')
      .addStringOption((option) =>
        option
          .setName('item')
          .setDescription('Item name.')
          .setRequired(true)
          .setAutocomplete(true)
      ),

    new SlashCommandBuilder()
      .setName('stock')
      .setDescription('Check whether a tracked item is in stock in one country.')
      .addStringOption((option) =>
        option
          .setName('item')
          .setDescription('Item name.')
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addStringOption((option) =>
        withCountryChoices(
          option
            .setName('country')
            .setDescription('Country to inspect.')
            .setRequired(true)
        )
      ),

    new SlashCommandBuilder()
      .setName('restock')
      .setDescription('Show the public DroqsDB restock estimate for one item.')
      .addStringOption((option) =>
        option
          .setName('item')
          .setDescription('Item name.')
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addStringOption((option) =>
        withCountryChoices(
          option
            .setName('country')
            .setDescription('Country to inspect.')
            .setRequired(true)
        )
      ),

    new SlashCommandBuilder()
      .setName('alert')
      .setDescription('Create and manage item/country stock alerts.')
      .addSubcommand((subcommand) =>
        subcommand
          .setName('create')
          .setDescription('Ping you when an item is available or ready to fly for.')
          .addStringOption((option) =>
            withCountryChoices(
              option
                .setName('country')
                .setDescription('Country to watch.')
                .setRequired(true)
            )
          )
          .addStringOption((option) =>
            option
              .setName('item')
              .setDescription('Item name.')
              .setRequired(true)
              .setAutocomplete(true)
          )
          .addStringOption((option) =>
            option
              .setName('mode')
              .setDescription('Available now or fly-out timing.')
              .setRequired(true)
              .addChoices(...ALERT_MODE_CHOICES)
          )
          .addStringOption((option) =>
            option
              .setName('repeat')
              .setDescription('Defaults to one-time. Choose every time for transition-based recurring pings.')
              .addChoices(...ALERT_REPEAT_CHOICES)
          )
          .addStringOption((option) =>
            option
              .setName('flight_type')
              .setDescription('Fly-out mode only. Defaults to the bot travel profile.')
              .addChoices(...FLIGHT_TYPE_CHOICES)
          )
          .addIntegerOption((option) =>
            option
              .setName('capacity')
              .setDescription('Fly-out mode only. Defaults to the bot travel profile.')
              .setMinValue(1)
              .setMaxValue(100)
          )
          .addStringOption((option) =>
            option
              .setName('note')
              .setDescription('Optional note for your own reference.')
              .setMaxLength(200)
          )
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('list')
          .setDescription('Show your active alerts in this server.')
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('remove')
          .setDescription('Remove one of your active alerts.')
          .addIntegerOption((option) =>
            option
              .setName('id')
              .setDescription('Alert ID from /alert list.')
              .setRequired(true)
              .setMinValue(1)
          )
      ),

    new SlashCommandBuilder()
      .setName('giveaway')
      .setDescription('Create and manage giveaways and giveaway mini games.')
      .addSubcommand((subcommand) =>
        subcommand
          .setName('status')
          .setDescription('Show active giveaway flights for this server.')
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('leaderboard')
          .setDescription('Show the all-time giveaway winners for this server.')
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('start')
          .setDescription('Start a giveaway in the current channel.')
          .addStringOption((option) =>
            option
              .setName('item')
              .setDescription('Prize text shown in the giveaway.')
              .setRequired(true)
              .setMaxLength(200)
          )
          .addIntegerOption((option) =>
            option
              .setName('winners')
              .setDescription('How many winners to draw.')
              .setRequired(true)
              .setMinValue(1)
              .setMaxValue(10)
          )
          .addStringOption((option) =>
            option
              .setName('game_type')
              .setDescription('Defaults to Standard. Mini-game modes auto-resolve to one winner.')
              .addChoices(...GIVEAWAY_GAME_TYPE_CHOICES)
          )
          .addStringOption((option) =>
            option
              .setName('end_mode')
              .setDescription('Defaults to timed unless you provide only a max entry count.')
              .addChoices(
                { name: 'Timed', value: 'time' },
                { name: 'Entry Target', value: 'entries' }
              )
          )
          .addStringOption((option) =>
            option
              .setName('duration')
              .setDescription('Timed mode only. Examples: 15m, 2h, 1h15m, 1d6h.')
              .setMaxLength(20)
          )
          .addIntegerOption((option) =>
            option
              .setName('max_entries')
              .setDescription('Entry-target mode only. Ends when this many entries are reached.')
              .setMinValue(1)
              .setMaxValue(500)
          )
          .addBooleanOption((option) =>
            option
              .setName('winner_cooldown')
              .setDescription('When on, recent winners must wait 3 minutes before entering again.')
          )
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('end')
          .setDescription('End a giveaway early and draw winners now.')
          .addStringOption((option) =>
            option
              .setName('message_id')
              .setDescription('Message ID of the giveaway message.')
              .setRequired(true)
              .setMaxLength(32)
          )
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('reroll')
          .setDescription('Reroll winners for a giveaway that already ended.')
          .addStringOption((option) =>
            option
              .setName('message_id')
              .setDescription('Message ID of the giveaway message.')
              .setRequired(true)
              .setMaxLength(32)
          )
      ),

    new SlashCommandBuilder()
      .setName('autopost')
      .setDescription('Configure DroqsDB autoposting for this server.')
      .addSubcommand((subcommand) =>
        subcommand
          .setName('enable')
          .setDescription('Enable hourly autoposts in a channel.')
          .addChannelOption((option) =>
            option
              .setName('channel')
              .setDescription('Channel to post hourly updates into.')
              .setRequired(true)
              .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          )
          .addIntegerOption((option) =>
            option
              .setName('count')
              .setDescription(`How many runs to post in Top N mode. Defaults to ${DEFAULT_AUTOPOST_COUNT}.`)
              .setMinValue(MIN_AUTOPOST_COUNT)
              .setMaxValue(MAX_AUTOPOST_COUNT)
          )
          .addStringOption((option) =>
            option
              .setName('mode')
              .setDescription('Posting layout. Defaults to Top N.')
              .addChoices(...AUTOPOST_MODE_CHOICES)
          )
          .addStringOption((option) =>
            option
              .setName('categories')
              .setDescription('Optional comma-separated categories, for example drugs,plushies.')
              .setMaxLength(100)
          )
          .addStringOption((option) =>
            option
              .setName('countries')
              .setDescription('Optional comma-separated countries, for example canada,japan.')
              .setMaxLength(200)
          )
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('daily-forecast')
          .setDescription('Configure the once-daily DroqsDB Travel Forecast post.')
          .addBooleanOption((option) =>
            option
              .setName('enabled')
              .setDescription('Turn the daily forecast autopost on or off.')
              .setRequired(true)
          )
          .addChannelOption((option) =>
            option
              .setName('channel')
              .setDescription('Channel to post the daily forecast into.')
              .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          )
          .addStringOption((option) =>
            option
              .setName('time')
              .setDescription(`TCT post time in HH:mm. Defaults to ${DEFAULT_DAILY_FORECAST_TIME}.`)
              .setMinLength(4)
              .setMaxLength(5)
          )
          .addIntegerOption((option) =>
            option
              .setName('count')
              .setDescription(`How many forecast items to post. Defaults to ${DEFAULT_DAILY_FORECAST_COUNT}.`)
              .setMinValue(MIN_DAILY_FORECAST_COUNT)
              .setMaxValue(MAX_DAILY_FORECAST_COUNT)
          )
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('disable')
          .setDescription('Disable hourly autoposting for this server.')
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('status')
          .setDescription('Show the current hourly autopost configuration for this server.')
      )
  ].map((command) => command.toJSON());
}

async function registerCommands() {
  assertBotConfig();

  const rest = new REST({ version: '10' }).setToken(config.discordToken);
  const body = buildCommands();
  const route = config.guildId
    ? Routes.applicationGuildCommands(config.clientId, config.guildId)
    : Routes.applicationCommands(config.clientId);

  await rest.put(route, { body });

  const scope = config.guildId ? `guild ${config.guildId}` : 'globally';
  logger.info('commands.registered', {
    commandCount: body.length,
    scope
  });
}

if (require.main === module) {
  registerCommands().catch((error) => {
    logger.error('commands.registration_failed', error);
    process.exitCode = 1;
  });
}

module.exports = {
  COUNTRY_CHOICES,
  buildCommands,
  registerCommands
};
