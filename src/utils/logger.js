import config from '../config.js';

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });

function normalizeLevel(input) {
  const normalized = String(input ?? '').trim().toLowerCase();
  return Object.hasOwn(LEVELS, normalized) ? normalized : 'info';
}

const activeLevel = normalizeLevel(config.logLevel ?? process.env.LOG_LEVEL);

function shouldLog(level) {
  return LEVELS[normalizeLevel(level)] >= LEVELS[activeLevel];
}

function serializeError(error) {
  if (!error) return undefined;
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}

function write(level, message, meta = {}) {
  if (!shouldLog(level)) return;
  const payload = {
    ts: new Date().toISOString(),
    level: normalizeLevel(level),
    message,
    service: meta.service ?? 'riftrecap',
    event: meta.event ?? null,
    ...meta,
  };
  if ('error' in meta) payload.error = serializeError(meta.error);
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

export const logger = {
  isLevelEnabled(level) {
    return shouldLog(level);
  },
  debug(message, meta) { write('debug', message, meta); },
  info(message, meta) { write('info', message, meta); },
  warn(message, meta) { write('warn', message, meta); },
  error(message, meta) { write('error', message, meta); },
};

export default logger;
