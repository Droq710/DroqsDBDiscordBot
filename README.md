# DroqsDB Bot

DroqsDB Bot is a Discord slash-command bot built with `discord.js` for public or private servers that want current DroqsDB travel, stock, pricing, and restock data inside Discord.

The bot stays intentionally thin:

- DroqsDB remains the source of truth
- the bot does not reimplement DroqsDB profitability logic
- API calls stay centralized in one client
- repeated API requests are cached briefly in memory
- command protection uses simple in-memory per-user and per-guild rate limits
- structured JSON logs make public hosting easier to monitor
- hourly autopost state stays per guild in a small SQLite database

## Features

- `/help`
- `/run best`
- `/run top count:<1-10>`
- `/run country country:<country> count:<1-10>`
- `/run item item:<item name>`
- `/run category category:<plushies|flowers|drugs> count:<1-10>`
- `/price item:<item name>`
- `/stock item:<item name> country:<country>`
- `/restock item:<item name> country:<country>`
- `/autopost enable channel:<channel> [count:<1-10>] [mode:<top_n|flight_groups|category_groups|full_breakdown>] [categories:<csv>] [countries:<csv>]`
- `/autopost disable`
- `/autopost status`

## Public-Use Hardening

This build includes:

- defensive interaction and startup error handling
- graceful user-facing handling when DroqsDB is temporarily unavailable
- short TTL caching with stale-cache fallback for brief upstream outages
- simple per-user and per-guild slash-command rate limiting
- structured JSON logging for startup, commands, API failures, and autopost jobs
- a startup health log that records cache, timeout, rate-limit, database, and DroqsDB status details

## Requirements

- Node.js 20+
- a Discord application and bot token

## Install

1. Install dependencies:

```bash
npm install
```

2. Copy `.env.example` to `.env` and fill in the required values.

3. Register slash commands:

```bash
npm run register:commands
```

4. Start the bot:

```bash
npm start
```

## Invite The Bot

Use the Discord OAuth URL below after replacing `YOUR_CLIENT_ID`:

```text
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot%20applications.commands&permissions=19456
```

The permission set above is the minimal set needed for normal operation:

- `View Channels`
- `Send Messages`
- `Embed Links`

If you are testing first, register commands with `DISCORD_GUILD_ID` set to your test guild. When you are ready for public multi-server usage, remove `DISCORD_GUILD_ID` and register commands again so Discord publishes them globally.

## Environment Variables

| Variable | Required | Description |
| --- | --- | --- |
| `DISCORD_TOKEN` | Yes | Discord bot token |
| `DISCORD_CLIENT_ID` | Yes | Discord application client ID |
| `DISCORD_GUILD_ID` | No | Test guild ID for fast command registration; omit for global commands |
| `LOG_LEVEL` | No | Structured log level: `debug`, `info`, `warn`, or `error` |
| `DROQSDB_API_BASE_URL` | No | DroqsDB public API base URL |
| `DROQSDB_WEB_BASE_URL` | No | DroqsDB website base URL |
| `API_CACHE_TTL_MS` | No | Fresh in-memory API cache TTL in milliseconds |
| `API_CACHE_STALE_TTL_MS` | No | Extra stale-cache window used only for brief upstream failures |
| `DROQSDB_API_TIMEOUT_MS` | No | Timeout for DroqsDB API requests in milliseconds |
| `COMMAND_USER_RATE_LIMIT_WINDOW_MS` | No | Per-user slash-command rate-limit window in milliseconds |
| `COMMAND_USER_RATE_LIMIT_MAX` | No | Max slash commands allowed per user inside one user window |
| `COMMAND_GUILD_RATE_LIMIT_WINDOW_MS` | No | Per-guild slash-command rate-limit window in milliseconds |
| `COMMAND_GUILD_RATE_LIMIT_MAX` | No | Max slash commands allowed per guild inside one guild window |
| `AUTOPOST_CRON` | No | Cron expression for hourly autoposts |
| `AUTOPOST_TIMEZONE` | No | Cron timezone |
| `AUTOPOST_DB_FILE` | No | SQLite path used to store per-guild autopost configuration |
| `AUTOPOST_DATA_FILE` | No | Optional legacy JSON path used for one-time migration from the MVP autopost storage |

## Privacy And Usage Note

This bot is command-driven. It does not read normal message content and only handles slash-command interactions, autocomplete requests, and autopost settings.

If you host the bot publicly, it will typically process and store:

- Discord guild IDs, channel IDs, and user IDs needed for command handling and autopost configuration
- command names, timing, and error details in structured logs
- per-guild autopost preferences in the SQLite database

It does not store Discord message history, and DroqsDB remains the source of truth for travel data. If you run the bot for other servers, make sure your README, hosting policy, and log retention settings match how you actually operate it.

## Autopost Behavior

- `/autopost enable` stores per-guild autopost settings in SQLite
- each guild keeps enabled or disabled state, channel, mode, count, and optional country/category filter arrays
- the scheduler loops through enabled guilds every hour
- overlapping scheduler runs are skipped defensively
- invalid or unsendable channel configs are disabled automatically with warning logs
- autopost fetch failures caused by DroqsDB downtime are skipped cleanly and retried on the next schedule

## Migration / Upgrade

- Install dependencies so `better-sqlite3` is available:

```bash
npm install
```

- If you are upgrading from the MVP JSON-backed autopost storage, leave `AUTOPOST_DATA_FILE` pointed at the old JSON file or keep the default `./data/autopost-config.json`.
- Start the bot once. If the SQLite database is empty, the bot will automatically import the legacy JSON guild mappings into `AUTOPOST_DB_FILE`.
- After the first successful startup, you can remove the old JSON file and the `AUTOPOST_DATA_FILE` override if you do not need it anymore.

## Architecture

```text
src/
  api/
    droqsdbClient.js
  constants/
    droqsdb.js
  discord/
    commandCatalog.js
    commandHandlers/
    registerCommands.js
  services/
    autopost.js
    cache.js
    guildConfigStore.js
    logger.js
    rateLimiter.js
  utils/
    autopost.js
    formatters.js
  config.js
  index.js
```

## Local Testing Tips

- start with `DISCORD_GUILD_ID` set so command updates appear quickly
- run `/help` to confirm the bot is online and command help looks right
- run `/run best` and `/price item:Xanax` to confirm DroqsDB access
- test rate limiting by calling a command repeatedly in a short burst
- use `/autopost enable` in a test channel, then `/autopost status` to confirm the stored config
- stop DroqsDB access temporarily or point `DROQSDB_API_BASE_URL` somewhere invalid to confirm downtime handling and stale-cache fallback behavior

## Data Source

This bot consumes the live DroqsDB public API:

- `https://droqsdb.com/api/public/v1/meta`
- `https://droqsdb.com/api/public/v1/top-profits`
- `https://droqsdb.com/api/public/v1/country/:country`
- `https://droqsdb.com/api/public/v1/item/:itemName`
- `https://droqsdb.com/api/public/v1/items`
- `https://droqsdb.com/api/public/v1/export`
