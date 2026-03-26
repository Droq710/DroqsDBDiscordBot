class TTLCache {
  constructor({ defaultTtlMs = 30_000, maxEntries = 250 } = {}) {
    this.defaultTtlMs = defaultTtlMs;
    this.maxEntries = maxEntries;
    this.store = new Map();
    this.inFlight = new Map();
  }

  getEntry(key, { allowExpired = false } = {}) {
    const entry = this.store.get(key);

    if (!entry) {
      return null;
    }

    const now = Date.now();

    if (now >= entry.staleUntil) {
      this.store.delete(key);
      return null;
    }

    if (!allowExpired && now >= entry.expiresAt) {
      return null;
    }

    return entry;
  }

  get(key) {
    const entry = this.getEntry(key);
    return entry ? entry.value : null;
  }

  getStale(key) {
    const entry = this.getEntry(key, { allowExpired: true });
    return entry ? entry.value : null;
  }

  set(key, value, ttlMs = this.defaultTtlMs, staleTtlMs = 0) {
    if (this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value;

      if (oldestKey) {
        this.store.delete(oldestKey);
      }
    }

    const expiresAt = Date.now() + ttlMs;
    this.store.set(key, {
      value,
      expiresAt,
      staleUntil: expiresAt + Math.max(0, staleTtlMs)
    });

    return value;
  }

  async getOrSet(
    key,
    factory,
    {
      ttlMs = this.defaultTtlMs,
      staleTtlMs = 0
    } = {}
  ) {
    const cached = this.get(key);

    if (cached !== null) {
      return cached;
    }

    if (this.inFlight.has(key)) {
      return this.inFlight.get(key);
    }

    const request = Promise.resolve()
      .then(factory)
      .then((value) => {
        this.set(key, value, ttlMs, staleTtlMs);
        this.inFlight.delete(key);
        return value;
      })
      .catch((error) => {
        this.inFlight.delete(key);
        throw error;
      });

    this.inFlight.set(key, request);
    return request;
  }

  clear() {
    this.store.clear();
    this.inFlight.clear();
  }
}

module.exports = {
  TTLCache
};
