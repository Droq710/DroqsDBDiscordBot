const assert = require('node:assert/strict');
const test = require('node:test');

const { DroqsDbApiError } = require('../src/api/droqsdbClient');
const { AutopostService } = require('../src/services/autopost');
const { AUTOPOST_MODES } = require('../src/utils/autopost');

const AUTOPOST_FALLBACK_MESSAGE =
  '⚠️ DroqsDB data temporarily unavailable. Will try again next hour.';

function createLoggerSpy() {
  const entries = [];

  return {
    entries,
    debug(message, ...args) {
      entries.push({
        level: 'debug',
        message,
        args
      });
    },
    info(message, ...args) {
      entries.push({
        level: 'info',
        message,
        args
      });
    },
    warn(message, ...args) {
      entries.push({
        level: 'warn',
        message,
        args
      });
    },
    error(message, ...args) {
      entries.push({
        level: 'error',
        message,
        args
      });
    }
  };
}

function createGuildConfig(overrides = {}) {
  return {
    guildId: 'guild-1',
    channelId: 'channel-1',
    autopostEnabled: true,
    count: 3,
    mode: AUTOPOST_MODES.FULL_BREAKDOWN,
    countries: [],
    categories: [],
    ...overrides
  };
}

function createGuildConfigStore(guildConfig) {
  return {
    async initialize() {},
    getGuildConfig() {
      return guildConfig;
    },
    listEnabledGuildConfigs() {
      return [guildConfig];
    },
    saveGuildAutopostConfig() {
      return guildConfig;
    },
    disableGuildAutopost() {
      return {
        ...guildConfig,
        autopostEnabled: false
      };
    },
    close() {}
  };
}

function createSendableChannel({ sendImpl } = {}) {
  return {
    id: 'channel-1',
    guildId: 'guild-1',
    isTextBased() {
      return true;
    },
    permissionsFor() {
      return {
        has() {
          return true;
        }
      };
    },
    async send(payload) {
      return sendImpl ? sendImpl(payload) : payload;
    }
  };
}

function createDiscordClient(channel) {
  return {
    user: {
      id: 'bot-user'
    },
    channels: {
      async fetch() {
        return channel;
      }
    }
  };
}

test(
  'autopost posts a normal full breakdown embed when the API succeeds',
  { concurrency: false },
  async () => {
  const logger = createLoggerSpy();
  const sentPayloads = [];
  const guildConfig = createGuildConfig();
  const channel = createSendableChannel({
    async sendImpl(payload) {
      sentPayloads.push(payload);
      return payload;
    }
  });
  const droqsdbClient = {
    requestTimeoutMs: 30_000,
    webBaseUrl: 'https://droqsdb.example',
    async getCurrentRunUniverseForFilters() {
      return {
        generatedAt: '2026-03-29T12:00:00.000Z',
        apiPath: '/api/top-profits',
        countries: [],
        categories: [],
        emptyStateGuidance: null,
        runs: [
          {
            itemName: 'Xanax',
            country: 'Canada',
            stock: 12,
            profitPerMinute: 123456
          }
        ]
      };
    }
  };
  const service = new AutopostService({
    discordClient: createDiscordClient(channel),
    droqsdbClient,
    guildConfigStore: createGuildConfigStore(guildConfig),
    cronExpression: '0 * * * *',
    timezone: 'America/Chicago',
    logger
  });

  await service.postForGuild(guildConfig, {
    scheduledFor: '2026-03-29T12:00:00.000Z',
    triggeredAt: '2026-03-29T12:00:01.000Z'
  });

  assert.equal(sentPayloads.length, 1);
  assert.equal(sentPayloads[0].content, undefined);
  assert.equal(Array.isArray(sentPayloads[0].embeds), true);
  assert.equal(sentPayloads[0].embeds.length, 1);
  assert.equal(
    logger.entries.some((entry) => entry.message === 'autopost.fallback_started'),
    false
  );
  }
);

test(
  'autopost retries one timeout and then posts the fallback message',
  { concurrency: false },
  async () => {
  const logger = createLoggerSpy();
  const sentPayloads = [];
  const guildConfig = createGuildConfig();
  const channel = createSendableChannel({
    async sendImpl(payload) {
      sentPayloads.push(payload);
      return payload;
    }
  });
  let attempts = 0;
  const timeoutError = new DroqsDbApiError('DroqsDB API request timed out.', {
    status: 504,
    code: 'API_TIMEOUT',
    retryable: true,
    upstreamUnavailable: true
  });
  const droqsdbClient = {
    requestTimeoutMs: 30_000,
    webBaseUrl: 'https://droqsdb.example',
    async getCurrentRunUniverseForFilters() {
      attempts += 1;
      throw timeoutError;
    }
  };
  const service = new AutopostService({
    discordClient: createDiscordClient(channel),
    droqsdbClient,
    guildConfigStore: createGuildConfigStore(guildConfig),
    cronExpression: '0 * * * *',
    timezone: 'America/Chicago',
    logger
  });

  await service.postForGuild(guildConfig);

  assert.equal(attempts, 2);
  assert.deepEqual(sentPayloads, [
    {
      content: AUTOPOST_FALLBACK_MESSAGE
    }
  ]);
  assert.equal(
    logger.entries.some((entry) => entry.message === 'autopost.fallback_started'),
    true
  );
  assert.equal(
    logger.entries.some((entry) => entry.message === 'autopost.fallback_completed'),
    true
  );
  assert.equal(
    logger.entries.some((entry) => entry.message === 'autopost.fallback_failed'),
    false
  );
  }
);

test(
  'fallback posting failures are logged and swallowed so autopost does not crash',
  { concurrency: false },
  async () => {
  const logger = createLoggerSpy();
  const guildConfig = createGuildConfig();
  const sendError = new Error('Channel is gone.');
  sendError.code = 10003;
  const channel = createSendableChannel({
    async sendImpl() {
      throw sendError;
    }
  });
  const service = new AutopostService({
    discordClient: createDiscordClient(channel),
    droqsdbClient: {
      requestTimeoutMs: 30_000,
      webBaseUrl: 'https://droqsdb.example'
    },
    guildConfigStore: createGuildConfigStore(guildConfig),
    cronExpression: '0 * * * *',
    timezone: 'America/Chicago',
    logger
  });

  service.disableInvalidConfig = async () => {
    throw new Error('Disable failed.');
  };

  await assert.doesNotReject(() =>
    service.sendFallbackMessage(channel, guildConfig, {}, {
      reason: 'fetch_failed'
    })
  );

  assert.equal(
    logger.entries.some((entry) => entry.message === 'autopost.fallback_started'),
    true
  );
  assert.equal(
    logger.entries.some((entry) => entry.message === 'autopost.fallback_completed'),
    false
  );
  assert.equal(
    logger.entries.some((entry) => entry.message === 'autopost.fallback_failed'),
    true
  );
  }
);
