function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

class FixedWindowRateLimiter {
  constructor({
    windowMs,
    maxHits,
    maxKeys = 5_000
  }) {
    this.windowMs = parsePositiveInteger(windowMs, 10_000);
    this.maxHits = parsePositiveInteger(maxHits, 5);
    this.maxKeys = parsePositiveInteger(maxKeys, 5_000);
    this.store = new Map();
  }

  take(key) {
    if (!key) {
      return {
        allowed: true,
        remaining: this.maxHits
      };
    }

    const now = Date.now();
    const existing = this.store.get(key);
    const activeWindow =
      existing && existing.resetAt > now
        ? existing
        : {
            count: 0,
            resetAt: now + this.windowMs
          };

    activeWindow.count += 1;
    this.store.set(key, activeWindow);

    if (this.store.size > this.maxKeys) {
      this.prune(now);
    }

    if (activeWindow.count > this.maxHits) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(0, activeWindow.resetAt - now),
        resetAt: activeWindow.resetAt,
        limit: this.maxHits,
        windowMs: this.windowMs
      };
    }

    return {
      allowed: true,
      remaining: Math.max(0, this.maxHits - activeWindow.count),
      retryAfterMs: 0,
      resetAt: activeWindow.resetAt,
      limit: this.maxHits,
      windowMs: this.windowMs
    };
  }

  prune(now = Date.now()) {
    for (const [key, value] of this.store.entries()) {
      if (value.resetAt <= now) {
        this.store.delete(key);
      }
    }

    while (this.store.size > this.maxKeys) {
      const oldestKey = this.store.keys().next().value;

      if (!oldestKey) {
        break;
      }

      this.store.delete(oldestKey);
    }
  }
}

class CommandRateLimiter {
  constructor({
    userWindowMs = 10_000,
    userMaxHits = 5,
    guildWindowMs = 10_000,
    guildMaxHits = 20,
    logger = console
  } = {}) {
    this.logger = logger;
    this.userLimiter = new FixedWindowRateLimiter({
      windowMs: userWindowMs,
      maxHits: userMaxHits
    });
    this.guildLimiter = new FixedWindowRateLimiter({
      windowMs: guildWindowMs,
      maxHits: guildMaxHits
    });
  }

  check(interaction) {
    const userResult = this.userLimiter.take(`user:${interaction.user?.id || 'unknown'}`);

    if (!userResult.allowed) {
      const result = {
        ...userResult,
        scope: 'user'
      };

      this.logger.warn('command.rate_limited', {
        scope: result.scope,
        commandName: interaction.commandName,
        guildId: interaction.guildId || null,
        userId: interaction.user?.id || null,
        retryAfterMs: result.retryAfterMs
      });

      return result;
    }

    if (!interaction.guildId) {
      return {
        allowed: true,
        scope: null
      };
    }

    const guildResult = this.guildLimiter.take(`guild:${interaction.guildId}`);

    if (!guildResult.allowed) {
      const result = {
        ...guildResult,
        scope: 'guild'
      };

      this.logger.warn('command.rate_limited', {
        scope: result.scope,
        commandName: interaction.commandName,
        guildId: interaction.guildId,
        userId: interaction.user?.id || null,
        retryAfterMs: result.retryAfterMs
      });

      return result;
    }

    return {
      allowed: true,
      scope: null
    };
  }
}

module.exports = {
  CommandRateLimiter
};
