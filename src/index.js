const { Client, Events, GatewayIntentBits, Partials } = require('discord.js');
const { DroqsDbClient } = require('./api/droqsdbClient');
const { assertBotConfig, config } = require('./config');
const { handleAutocomplete, handleChatInputCommand } = require('./discord/commandHandlers');
const { AutopostService } = require('./services/autopost');
const { TTLCache } = require('./services/cache');
const { GiveawayService } = require('./services/giveaway');
const { GiveawayStore } = require('./services/giveawayStore');
const { GuildConfigStore } = require('./services/guildConfigStore');
const { createLogger } = require('./services/logger');
const { CommandRateLimiter } = require('./services/rateLimiter');

const rootLogger = createLogger({
  level: config.logLevel,
  context: {
    environment: process.env.NODE_ENV || 'development'
  }
});

async function main() {
  const logger = rootLogger.child({
    component: 'startup'
  });

  assertBotConfig();

  logger.info('startup.begin', {
    nodeVersion: process.version,
    logLevel: config.logLevel,
    guildRegistrationScope: config.guildId ? 'guild' : 'global'
  });

  const cache = new TTLCache({
    defaultTtlMs: config.apiCacheTtlMs
  });

  const discordClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.MessageContent
    ],
    partials: [
      Partials.Channel,
      Partials.Message,
      Partials.Reaction,
      Partials.User
    ]
  });

  const droqsdbClient = new DroqsDbClient({
    baseUrl: config.droqsdbApiBaseUrl,
    webBaseUrl: config.droqsdbWebBaseUrl,
    cache,
    logger: rootLogger.child({
      component: 'droqsdb_api'
    }),
    defaultTtlMs: config.apiCacheTtlMs,
    defaultStaleTtlMs: config.apiCacheStaleTtlMs,
    requestTimeoutMs: config.droqsdbApiTimeoutMs
  });

  const guildConfigStore = new GuildConfigStore({
    databasePath: config.autopostDbFile,
    legacyStoragePath: config.legacyAutopostDataFile,
    logger: rootLogger.child({
      component: 'guild_config_store'
    })
  });
  const giveawayStore = new GiveawayStore({
    databasePath: config.autopostDbFile,
    logger: rootLogger.child({
      component: 'giveaway_store'
    })
  });

  const autopostService = new AutopostService({
    discordClient,
    droqsdbClient,
    guildConfigStore,
    cronExpression: config.autopostCron,
    timezone: config.autopostTimezone,
    logger: rootLogger.child({
      component: 'autopost'
    })
  });
  const giveawayService = new GiveawayService({
    discordClient,
    giveawayStore,
    logger: rootLogger.child({
      component: 'giveaway'
    })
  });

  const rateLimiter = new CommandRateLimiter({
    userWindowMs: config.commandUserRateLimitWindowMs,
    userMaxHits: config.commandUserRateLimitMax,
    guildWindowMs: config.commandGuildRateLimitWindowMs,
    guildMaxHits: config.commandGuildRateLimitMax,
    logger: rootLogger.child({
      component: 'rate_limiter'
    })
  });

  await guildConfigStore.initialize();
  await giveawayStore.initialize();

  const health = await runStartupHealthCheck({
    droqsdbClient,
    guildConfigStore,
    giveawayStore,
    logger
  });

  logger.info('startup.health', {
    apiBaseUrl: config.droqsdbApiBaseUrl,
    autopostCron: config.autopostCron,
    autopostDatabasePath: config.autopostDbFile,
    autopostTimezone: config.autopostTimezone,
    commandGuildRateLimitMax: config.commandGuildRateLimitMax,
    commandGuildRateLimitWindowMs: config.commandGuildRateLimitWindowMs,
    commandUserRateLimitMax: config.commandUserRateLimitMax,
    commandUserRateLimitWindowMs: config.commandUserRateLimitWindowMs,
    droqsdbStatus: health.droqsdbStatus,
    enabledAutopostGuilds: health.enabledAutopostGuilds,
    pendingGiveaways: health.pendingGiveaways,
    metaGeneratedAt: health.generatedAt,
    requestTimeoutMs: config.droqsdbApiTimeoutMs,
    shortCacheStaleTtlMs: config.apiCacheStaleTtlMs,
    shortCacheTtlMs: config.apiCacheTtlMs
  });

  const context = {
    config,
    droqsdbClient,
    autopostService,
    giveawayService,
    logger: rootLogger.child({
      component: 'commands'
    }),
    rateLimiter
  };

  discordClient.once(Events.ClientReady, async (client) => {
    logger.info('discord.ready', {
      botTag: client.user.tag,
      guildCount: client.guilds.cache.size,
      userId: client.user.id
    });

    try {
      await autopostService.start();
      logger.info('startup.ready', {
        autopostScheduler: 'started'
      });
    } catch (error) {
      logger.error('startup.autopost_start_failed', error);
    }

    try {
      await giveawayService.start();
      logger.info('startup.ready', {
        giveawayScheduler: 'started'
      });
    } catch (error) {
      logger.error('startup.giveaway_start_failed', error);
    }
  });

  discordClient.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isAutocomplete()) {
        await handleAutocomplete(interaction, context);
        return;
      }

      if (!interaction.isChatInputCommand()) {
        return;
      }

      await handleChatInputCommand(interaction, context);
    } catch (error) {
      rootLogger.error('discord.interaction_unhandled_error', error, {
        commandName: interaction.commandName,
        guildId: interaction.guildId || null,
        userId: interaction.user?.id || null
      });
    }
  });

  discordClient.on(Events.MessageReactionAdd, async (reaction, user) => {
    try {
      await giveawayService.handleReactionAdd(reaction, user);
    } catch (error) {
      rootLogger.error('discord.reaction_add_unhandled_error', error, {
        messageId: reaction.message?.id || null,
        userId: user?.id || null
      });
    }
  });

  discordClient.on(Events.MessageCreate, async (message) => {
    try {
      await giveawayService.handleHostPrizeConfirmationMessage(message);
    } catch (error) {
      rootLogger.error('discord.message_create_unhandled_error', error, {
        channelId: message.channelId || null,
        guildId: message.guildId || null,
        messageId: message.id || null,
        userId: message.author?.id || null
      });
    }
  });

  discordClient.on(Events.Error, (error) => {
    rootLogger.error('discord.client_error', error);
  });

  if (typeof Events.Warn === 'string') {
    discordClient.on(Events.Warn, (warning) => {
      rootLogger.warn('discord.client_warning', {
        warning
      });
    });
  }

  let shuttingDown = false;

  async function shutdown(signal, exitCode = 0) {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info('shutdown.begin', {
      signal
    });

    try {
      autopostService.stop();
    } catch (error) {
      logger.error('shutdown.autopost_stop_failed', error);
    }

    try {
      giveawayService.stop();
    } catch (error) {
      logger.error('shutdown.giveaway_stop_failed', error);
    }

    try {
      discordClient.destroy();
    } catch (error) {
      logger.error('shutdown.discord_destroy_failed', error);
    }

    logger.info('shutdown.complete', {
      signal
    });
    process.exit(exitCode);
  }

  process.on('SIGINT', () => {
    void shutdown('SIGINT', 0);
  });

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM', 0);
  });

  process.on('unhandledRejection', (error) => {
    rootLogger.error('process.unhandled_rejection', error);
  });

  process.on('uncaughtException', (error) => {
    rootLogger.error('process.uncaught_exception', error);
    void shutdown('uncaughtException', 1);
  });

  process.on('warning', (warning) => {
    rootLogger.warn('process.warning', warning);
  });

  await discordClient.login(config.discordToken);
}

async function runStartupHealthCheck({
  droqsdbClient,
  guildConfigStore,
  giveawayStore,
  logger
}) {
  let droqsdbStatus = 'degraded';
  let generatedAt = null;

  try {
    const meta = await droqsdbClient.getMeta();
    droqsdbStatus = 'ok';
    generatedAt = meta.generatedAt || null;
  } catch (error) {
    logger.warn('startup.droqsdb_health_check_failed', error);
  }

  return {
    droqsdbStatus,
    enabledAutopostGuilds: guildConfigStore.listEnabledGuildConfigs().length,
    pendingGiveaways: giveawayStore.listPendingGiveaways().length,
    generatedAt
  };
}

main().catch((error) => {
  rootLogger.error('startup.failed', error);
  process.exitCode = 1;
});
