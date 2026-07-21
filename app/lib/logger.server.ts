/**
 * Structured logger. Never logs tokens or secrets.
 */

type LogLevel = "info" | "warn" | "error" | "debug";

const REDACT_KEYS = [
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "apiSecret",
  "api_secret",
  "secret",
  "password",
  "token",
];

function redact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const keyLower = k.toLowerCase();
    if (REDACT_KEYS.some((r) => keyLower.includes(r.toLowerCase()))) {
      out[k] = "[REDACTED]";
    } else if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)) {
      out[k] = redact(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function formatMessage(level: LogLevel, message: string, meta?: Record<string, unknown>): string {
  const timestamp = new Date().toISOString();
  const metaStr = meta ? ` ${JSON.stringify(redact(meta))}` : "";
  return `[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}`;
}

export const logger = {
  info(message: string, meta?: Record<string, unknown>): void {
    console.log(formatMessage("info", message, meta));
  },
  warn(message: string, meta?: Record<string, unknown>): void {
    console.warn(formatMessage("warn", message, meta));
  },
  error(message: string, meta?: Record<string, unknown>): void {
    console.error(formatMessage("error", message, meta));
  },
  debug(message: string, meta?: Record<string, unknown>): void {
    if (process.env.NODE_ENV === "development") {
      console.debug(formatMessage("debug", message, meta));
    }
  },
};
