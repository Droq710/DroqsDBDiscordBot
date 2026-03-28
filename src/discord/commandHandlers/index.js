const autopost = require('./autopost');
const giveaway = require('./giveaway');
const help = require('./help');
const price = require('./price');
const restock = require('./restock');
const run = require('./run');
const stock = require('./stock');
const {
  DroqsDbApiError,
  DroqsDbLookupError
} = require('../../api/droqsdbClient');
const {
  buildErrorEmbed,
  buildInfoEmbed,
  buildLookupErrorEmbed,
  buildRateLimitEmbed
} = require('../../utils/formatters');

const handlers = Object.freeze({
  autopost,
  giveaway,
  help,
  price,
  restock,
  run,
  stock
});

async function handleChatInputCommand(interaction, context) {
  const handler = handlers[interaction.commandName];
  const logger = context.logger.child({
    commandName: interaction.commandName,
    guildId: interaction.guildId || null,
    interactionType: 'chat_input',
    subcommand: getSubcommandName(interaction),
    userId: interaction.user?.id || null
  });

  if (!handler) {
    logger.warn('command.unknown');
    await sendInteractionPayload(interaction, {
      embeds: [buildErrorEmbed('Unknown Command', 'That command is not implemented.')],
      ephemeral: true
    });
    return;
  }

  const rateLimit = context.rateLimiter.check(interaction);

  if (!rateLimit.allowed) {
    await sendInteractionPayload(interaction, {
      embeds: [buildRateLimitEmbed(rateLimit)],
      ephemeral: true
    }, logger);
    return;
  }

  const startedAt = Date.now();
  logger.info('command.started');

  try {
    await handler.execute(interaction, {
      ...context,
      logger
    });
    logger.info('command.completed', {
      durationMs: Date.now() - startedAt
    });
  } catch (error) {
    logger.error('command.failed', error, {
      durationMs: Date.now() - startedAt
    });
    await replyWithError(interaction, error, {
      ...context,
      logger
    });
  }
}

async function handleAutocomplete(interaction, context) {
  const focused = interaction.options.getFocused(true);
  const logger = context.logger.child({
    commandName: interaction.commandName,
    guildId: interaction.guildId || null,
    interactionType: 'autocomplete',
    userId: interaction.user?.id || null
  });

  if (focused.name !== 'item') {
    await safeAutocompleteResponse(interaction, [], logger);
    return;
  }

  try {
    const suggestions = await context.droqsdbClient.suggestItems(focused.value);
    await safeAutocompleteResponse(
      interaction,
      suggestions.slice(0, 25).map((itemName) => ({
        name: itemName,
        value: itemName
      })),
      logger
    );
  } catch (error) {
    logger.warn('autocomplete.failed', error, {
      focusedName: focused.name
    });
    await safeAutocompleteResponse(interaction, [], logger);
  }
}

async function replyWithError(interaction, error, context) {
  let embed;

  if (error instanceof DroqsDbLookupError) {
    embed = buildLookupErrorEmbed(error);
  } else if (error instanceof DroqsDbApiError) {
    if (error.status === 404 || error.code === 'ITEM_NOT_FOUND') {
      embed = buildInfoEmbed('Not Found', error.message, {
        url: context.config.droqsdbWebBaseUrl
      });
    } else if (error.upstreamUnavailable || error.retryable) {
      embed = buildInfoEmbed(
        'DroqsDB Temporarily Unavailable',
        'DroqsDB is currently unavailable or responding too slowly. Please try again in a moment.',
        {
          url: context.config.droqsdbWebBaseUrl
        }
      );
    } else {
      embed = buildErrorEmbed(
        'DroqsDB API Error',
        'The DroqsDB API request failed. Please try again in a moment.'
      );
    }
  } else {
    embed = buildErrorEmbed(
      'Command Failed',
      error.message || 'An unexpected error occurred while running this command.'
    );
  }

  await sendInteractionPayload(interaction, {
    embeds: [embed],
    ephemeral: true
  }, context.logger);
}

async function sendInteractionPayload(interaction, payload, logger = console) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload);
      return;
    }

    await interaction.reply(payload);
  } catch (error) {
    logger.error('interaction.response_failed', error, {
      commandName: interaction.commandName,
      deferred: interaction.deferred,
      replied: interaction.replied
    });
  }
}

async function safeAutocompleteResponse(interaction, choices, logger = console) {
  try {
    await interaction.respond(choices);
  } catch (error) {
    logger.warn('autocomplete.response_failed', error, {
      commandName: interaction.commandName,
      choiceCount: choices.length
    });
  }
}

function getSubcommandName(interaction) {
  try {
    return interaction.options.getSubcommand(false) || null;
  } catch (error) {
    return null;
  }
}

module.exports = {
  handleAutocomplete,
  handleChatInputCommand
};
