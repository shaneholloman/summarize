type ExtensionLogLevel = "info" | "warn" | "error" | "verbose";

export type ExtensionLogEvent = {
  event: string;
  level?: ExtensionLogLevel;
  detail?: Record<string, unknown>;
  scope?: string;
};

const MAX_LINE_LENGTH = 4000;

const clampString = (value: string, limit = 300) => {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}…`;
};

export const normalizeDetailValue = (
  value: unknown,
): string | number | boolean | string[] | null => {
  if (value == null) return null;
  if (typeof value === "string") return clampString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) return clampString(value.message);
  if (Array.isArray(value)) {
    const preview = value.slice(0, 6).map((item) => {
      if (typeof item === "string") return clampString(item, 120);
      if (typeof item === "number" || typeof item === "boolean") return String(item);
      if (item instanceof Error) return clampString(item.message, 120);
      try {
        return clampString(JSON.stringify(item), 120);
      } catch {
        return String(item);
      }
    });
    return preview;
  }
  if (typeof value === "object") {
    try {
      return clampString(JSON.stringify(value), 300);
    } catch {
      return clampString(String(value));
    }
  }
  return clampString(String(value));
};

export const normalizeDetails = (detail?: Record<string, unknown>) => {
  if (!detail) return {};
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    const normalizedValue = normalizeDetailValue(value);
    if (normalizedValue == null) continue;
    normalized[key] = normalizedValue;
  }
  return normalized;
};

export const buildLogLine = (event: ExtensionLogEvent) => {
  const level = event.level ?? "info";
  const details = normalizeDetails(event.detail);
  const entry = {
    date: new Date().toISOString(),
    logLevelName: level,
    event: event.event,
    ...(event.scope ? { scope: event.scope } : {}),
    ...details,
  };
  let line = JSON.stringify(entry);
  if (line.length > MAX_LINE_LENGTH) {
    line = JSON.stringify({
      date: entry.date,
      logLevelName: level,
      event: event.event,
      ...(event.scope ? { scope: event.scope } : {}),
      detail: "truncated",
    });
  }
  return line;
};

export const parseLogMtime = (line: string | null | undefined): number | null => {
  if (!line) return null;
  try {
    const parsed = JSON.parse(line) as { date?: string };
    if (!parsed?.date) return null;
    const parsedDate = new Date(parsed.date);
    const time = parsedDate.getTime();
    return Number.isNaN(time) ? null : time;
  } catch {
    return null;
  }
};

