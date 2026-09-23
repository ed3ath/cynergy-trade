/**
 * Structured JSON logger with levels, context binding, and redaction.
 * No external dependency — uses process.stdout directly for performance.
 *
 * ponytail: switch to pino when throughput becomes a concern (just swap this module)
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Fields that must never appear in log output. */
const REDACTED_KEYS = new Set([
  "privateKey",
  "privatekey",
  "seedPhrase",
  "seedphrase",
  "mnemonic",
  "secret",
  "password",
  "apiKey",
  "apikey",
  "authorization",
  "credentials",
]);

function redact(obj: unknown, depth = 0): unknown {
  if (depth > 6 || obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    out[k] = REDACTED_KEYS.has(k.toLowerCase()) ? "[REDACTED]" : redact(v, depth + 1);
  }
  return out;
}

export interface LogEntry {
  time: string;
  level: LogLevel;
  msg: string;
  [key: string]: unknown;
}

let globalLevel: LogLevel = "info";
let prettyMode = false;

export function configureLogger(opts: { level?: LogLevel; pretty?: boolean }): void {
  if (opts.level) globalLevel = opts.level;
  if (opts.pretty !== undefined) prettyMode = opts.pretty;
}

function emit(level: LogLevel, msg: string, ctx: Record<string, unknown>): void {
  if (LEVELS[level] < LEVELS[globalLevel]) return;

  const entry: LogEntry = {
    time: new Date().toISOString(),
    level,
    msg,
    ...redact(ctx) as Record<string, unknown>,
  };

  if (prettyMode) {
    const color = { debug: "\x1b[37m", info: "\x1b[36m", warn: "\x1b[33m", error: "\x1b[31m" }[level];
    // component renders as a bracketed tag; AI components get magenta so they stand out
    const component = typeof entry.component === "string" ? entry.component : undefined;
    const tagColor = component?.startsWith("ai") ? "\x1b[35m" : "\x1b[90m";
    const tag = component ? `${tagColor}[${component}]\x1b[0m ` : "";
    const rest = Object.entries(entry)
      .filter(([k]) => !["time", "level", "msg", "component"].includes(k))
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(" ");
    process.stdout.write(`${color}${entry.time} [${level.toUpperCase()}]${tag ? ` ${tag}` : ""} ${msg}\x1b[0m ${rest}\n`);
  } else {
    process.stdout.write(JSON.stringify(entry) + "\n");
  }
}

export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export function createLogger(bindings: Record<string, unknown> = {}): Logger {
  const log = (level: LogLevel, msg: string, ctx: Record<string, unknown> = {}) =>
    emit(level, msg, { ...bindings, ...ctx });

  return {
    debug: (msg, ctx = {}) => log("debug", msg, ctx),
    info:  (msg, ctx = {}) => log("info",  msg, ctx),
    warn:  (msg, ctx = {}) => log("warn",  msg, ctx),
    error: (msg, ctx = {}) => log("error", msg, ctx),
    child: (extra) => createLogger({ ...bindings, ...extra }),
  };
}

export const logger = createLogger({ service: "autonomous-trader" });
