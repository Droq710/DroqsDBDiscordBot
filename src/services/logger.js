const os = require('node:os');

const LEVELS = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
});

function normalizeLevel(level) {
  const normalized = String(level || '')
    .trim()
    .toLowerCase();

  return Object.prototype.hasOwnProperty.call(LEVELS, normalized) ? normalized : 'info';
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function serializeValue(value, seen = new WeakSet()) {
  if (value === null || value === undefined) {
    return value ?? null;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value === 'function') {
    return `[Function ${value.name || 'anonymous'}]`;
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return '[Circular]';
  }

  if (value instanceof Error) {
    return serializeError(value, seen);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => serializeValue(entry, seen));
  }

  if (!isPlainObject(value)) {
    return String(value);
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, serializeValue(entry, seen)])
  );
}

function serializeError(error, seen = new WeakSet()) {
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    code: error.code,
    status: error.status,
    retryable: error.retryable,
    upstreamUnavailable: error.upstreamUnavailable,
    details: serializeValue(error.details, seen)
  };
}

function normalizeArgs(args) {
  let error = null;
  const context = {};
  const details = [];

  for (const arg of args) {
    if (arg === undefined) {
      continue;
    }

    if (!error && arg instanceof Error) {
      error = arg;
      continue;
    }

    if (isPlainObject(arg)) {
      Object.assign(context, serializeValue(arg));
      continue;
    }

    details.push(serializeValue(arg));
  }

  if (details.length) {
    context.details = details;
  }

  return {
    context,
    error
  };
}

class StructuredLogger {
  constructor({
    level = 'info',
    context = {}
  } = {}) {
    this.level = normalizeLevel(level);
    this.context = {
      service: 'droqsdb-discord-bot',
      host: os.hostname(),
      pid: process.pid,
      ...serializeValue(context)
    };
  }

  child(context = {}) {
    return new StructuredLogger({
      level: this.level,
      context: {
        ...this.context,
        ...serializeValue(context)
      }
    });
  }

  shouldLog(level) {
    return LEVELS[level] >= LEVELS[this.level];
  }

  write(level, message, ...args) {
    if (!this.shouldLog(level)) {
      return;
    }

    const { context, error } = normalizeArgs(args);
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message: String(message),
      ...this.context
    };

    if (Object.keys(context).length) {
      entry.context = context;
    }

    if (error) {
      entry.error = serializeError(error);
    }

    const line = `${JSON.stringify(entry)}\n`;

    if (level === 'error') {
      process.stderr.write(line);
      return;
    }

    process.stdout.write(line);
  }

  debug(message, ...args) {
    this.write('debug', message, ...args);
  }

  info(message, ...args) {
    this.write('info', message, ...args);
  }

  log(message, ...args) {
    this.info(message, ...args);
  }

  warn(message, ...args) {
    this.write('warn', message, ...args);
  }

  error(message, ...args) {
    this.write('error', message, ...args);
  }
}

function createLogger(options = {}) {
  return new StructuredLogger(options);
}

module.exports = {
  createLogger
};
