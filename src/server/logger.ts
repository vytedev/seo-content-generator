/**
 * Minimal structured logger for the local API. Zero dependencies: one JSON
 * object per line on stdout, so `npm run dev` output (and /tmp redirect) is
 * machine-greppable while staying readable in the terminal.
 *
 * Rules (matching the engineering rules): never log secrets — callers pass
 * fields explicitly; the logger adds nothing it was not given.
 */

const level = (process.env.LOG_LEVEL ?? "info").toLowerCase();

const severityRank: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function write(
  severity: keyof typeof severityRank,
  event: string,
  fields: Record<string, unknown> = {},
) {
  if ((severityRank[severity] ?? 20) < (severityRank[level] ?? 20)) return;
  process.stdout.write(
    `${JSON.stringify({ time: new Date().toISOString(), level: severity, event, ...fields })}\n`,
  );
}

export const logger = {
  debug: (event: string, fields?: Record<string, unknown>) => write("debug", event, fields),
  info: (event: string, fields?: Record<string, unknown>) => write("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => write("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => write("error", event, fields),
};

/** Redacts nothing it wasn't told about: the caller picks the fields. */
export function errorFields(error: unknown): Record<string, unknown> {
  return {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error).slice(0, 200),
    stack: error instanceof Error ? (error.stack ?? "").split("\n", 2)[1]?.trim() : undefined,
  };
}
