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
    dailyForecastEnabled: false,
    dailyForecastChannelId: null,
    dailyForecastTime: '08:00',
    dailyForecastCount: 10,
    dailyForecastLastPostDate: null,
    ...overrides
  };
}

function createGuildConfigStore(guildConfig) {
  let storedGuildConfig = guildConfig;

  return {
    async initialize() {},
    getGuildConfig() {
      return storedGuildConfig;
    },
    listEnabledGuildConfigs() {
      return storedGuildConfig.autopostEnabled ? [storedGuildConfig] : [];
    },
    listEnabledDailyForecastConfigs() {
      return storedGuildConfig.dailyForecastEnabled ? [storedGuildConfig] : [];
    },
    saveGuildAutopostConfig(config) {
      storedGuildConfig = {
        ...storedGuildConfig,
        ...config,
        autopostEnabled: true
      };
      return storedGuildConfig;
    },
    disableGuildAutopost() {
      storedGuildConfig = {
        ...storedGuildConfig,
        autopostEnabled: false
      };
      return storedGuildConfig;
    },
    saveGuildDailyForecastConfig(config) {
      storedGuildConfig = {
        ...storedGuildConfig,
        dailyForecastEnabled: true,
        dailyForecastChannelId: config.channelId,
        dailyForecastTime: config.time,
        dailyForecastCount: config.count
      };
      return storedGuildConfig;
    },
    disableGuildDailyForecast() {
      storedGuildConfig = {
        ...storedGuildConfig,
        dailyForecastEnabled: false
      };
      return storedGuildConfig;
    },
    markDailyForecastPosted({ dateKey }) {
      storedGuildConfig = {
        ...storedGuildConfig,
        dailyForecastLastPostDate: dateKey
      };
      return storedGuildConfig;
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
  'daily forecast scheduler posts only when a guild is due at its configured TCT time',
  { concurrency: false },
  async () => {
  const logger = createLoggerSpy();
  const sentPayloads = [];
  const guildConfig = createGuildConfig({
    autopostEnabled: false,
    dailyForecastEnabled: true,
    dailyForecastChannelId: 'channel-1',
    dailyForecastTime: '08:00',
    dailyForecastCount: 2
  });
  const store = createGuildConfigStore(guildConfig);
  const channel = createSendableChannel({
    async sendImpl(payload) {
      sentPayloads.push(payload);
      return payload;
    }
  });
  const droqsdbClient = {
    requestTimeoutMs: 30_000,
    webBaseUrl: 'https://droqsdb.example',
    async getDailyForecast() {
      return {
        generatedAt: '2026-04-28T08:00:00.000Z',
        apiPath: '/api/public/v1/daily-forecast',
        horizonHours: 24,
        items: [
          createForecastItem('Xanax', 'Japan'),
          createForecastItem('Combat Helmet', 'South Africa')
        ]
      };
    }
  };
  const service = new AutopostService({
    discordClient: createDiscordClient(channel),
    droqsdbClient,
    guildConfigStore: store,
    cronExpression: '0 * * * *',
    timezone: 'America/Chicago',
    logger
  });

  await service.postDailyForecasts({
    scheduledFor: '2026-04-28T07:59:00.000Z',
    triggeredAt: '2026-04-28T07:59:01.000Z'
  });
  await service.postDailyForecasts({
    scheduledFor: '2026-04-28T08:00:00.000Z',
    triggeredAt: '2026-04-28T08:00:01.000Z'
  });
  await service.postDailyForecasts({
    scheduledFor: '2026-04-28T08:01:00.000Z',
    triggeredAt: '2026-04-28T08:01:01.000Z'
  });

  assert.equal(sentPayloads.length, 1);
  assert.equal(sentPayloads[0].embeds.length, 1);
  assert.equal(store.getGuildConfig('guild-1').dailyForecastLastPostDate, '2026-04-28');
  assert.equal(
    logger.entries.some((entry) => entry.message === 'daily_forecast.posted'),
    true
  );
  }
);

test(
  'daily forecast API failures are logged and skipped without posting or crashing',
  { concurrency: false },
  async () => {
  const logger = createLoggerSpy();
  const sentPayloads = [];
  const guildConfig = createGuildConfig({
    autopostEnabled: false,
    dailyForecastEnabled: true,
    dailyForecastChannelId: 'channel-1',
    dailyForecastTime: '08:00'
  });
  const store = createGuildConfigStore(guildConfig);
  const channel = createSendableChannel({
    async sendImpl(payload) {
      sentPayloads.push(payload);
      return payload;
    }
  });
  const apiError = new DroqsDbApiError('Daily forecast is unavailable.', {
    status: 500,
    code: 'API_ERROR',
    retryable: false
  });
  const service = new AutopostService({
    discordClient: createDiscordClient(channel),
    droqsdbClient: {
      requestTimeoutMs: 30_000,
      webBaseUrl: 'https://droqsdb.example',
      async getDailyForecast() {
        throw apiError;
      }
    },
    guildConfigStore: store,
    cronExpression: '0 * * * *',
    timezone: 'America/Chicago',
    logger
  });

  await assert.doesNotReject(() =>
    service.postDailyForecastForGuild(guildConfig, {
      scheduledFor: '2026-04-28T08:00:00.000Z',
      triggeredAt: '2026-04-28T08:00:01.000Z'
    })
  );

  assert.equal(sentPayloads.length, 0);
  assert.equal(store.getGuildConfig('guild-1').dailyForecastLastPostDate, null);
  assert.equal(
    logger.entries.some((entry) => entry.message === 'daily_forecast.fetch_failed_final'),
    true
  );
  }
);

function createForecastItem(itemName, country, overrides = {}) {
  return {
    itemName,
    country,
    profitPerItem: 123456,
    profitPerMinute: 1234,
    confidence: 'high',
    confidencePercent: 88,
    bestSafetyMarginMinutes: 20,
    flyOutWindows: [
      {
        leaveAt: '2026-04-28T08:30:00.000Z',
        leaveAtTct: '08:30 TCT',
        leaveWindowEndAt: '2026-04-28T09:30:00.000Z',
        leaveWindowEndAtTct: '09:30 TCT',
        availability: 'projected_on_arrival',
        reason: 'Predicted restock before arrival with sufficient learned stock window.'
      }
    ],
    ...overrides
  };
}

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
