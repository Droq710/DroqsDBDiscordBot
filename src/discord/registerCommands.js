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
  DEFAULT_AUTOPOST_COUNT,
  MAX_AUTOPOST_COUNT,
  MIN_AUTOPOST_COUNT
} = require('../utils/autopost');

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
      .setName('autopost')
      .setDescription('Configure hourly DroqsDB autoposting for this server.')
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
              .setDescription(`How many runs to post. Defaults to ${DEFAULT_AUTOPOST_COUNT}.`)
              .setMinValue(MIN_AUTOPOST_COUNT)
              .setMaxValue(MAX_AUTOPOST_COUNT)
          )
          .addStringOption((option) =>
            option
              .setName('category')
              .setDescription('Optional category filter.')
              .addChoices(...RUN_CATEGORY_CHOICES)
          )
          .addStringOption((option) =>
            withCountryChoices(
              option
                .setName('country')
                .setDescription('Optional country filter.')
            )
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
