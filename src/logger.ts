/**
 * Dependency-free structured logger. `pretty` for the terminal, `json` for
 * log pipelines. Decimal/bigint-safe field serialisation.
 */
import { Decimal } from 'decimal.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

/** Make Decimals (and bigints) JSON-safe without losing precision. */
function normalise(value: unknown): unknown {
  if (value instanceof Decimal) return value.toString();
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(normalise);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, val]) => [key, normalise(val)]),
    );
  }
  return value;
}

export interface Logger {
  level: LogLevel;
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export function createLogger(
  format: 'pretty' | 'json' = 'pretty',
  level: LogLevel = 'info',
): Logger {
  const emit = (severity: LogLevel, event: string, fields?: Record<string, unknown>) => {
    if (LEVELS[severity] < LEVELS[level]) return;
    const now = new Date();
    const ts = format === 'json' ? now.toISOString() : now.toTimeString().slice(0, 8);
    const data = fields ? (normalise(fields) as Record<string, unknown>) : undefined;

    if (format === 'json') {
      console.log(JSON.stringify({ ts, level: severity, event, ...data }));
      return;
    }
    const tag = { debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR' }[severity];
    const head = `${ts} ${tag} ${event}`;
    if (!data || Object.keys(data).length === 0) {
      console.log(head);
      return;
    }
    const body = Object.entries(data)
      .map(([key, val]) => `${key}=${typeof val === 'object' ? JSON.stringify(val) : String(val)}`)
      .join('  ');
    console.log(`${head}  ${body}`);
  };

  return {
    level,
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
  };
}
