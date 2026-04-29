// SQLite's `datetime('now')` returns a UTC timestamp without a 'Z' suffix
// (e.g. "2026-04-27 21:06:37"). Plain `new Date(...)` parses that as local
// time, which silently shifts the value by the server's timezone offset and
// breaks every "since" comparison against ISO timestamps from APIs.
//
// Use this helper any time you read a datetime column from SQLite and need
// to compare it to a timestamp from elsewhere.
export function parseSqliteUtc(text: string): Date {
  if (!text) return new Date(NaN);
  // Already ISO-with-Z or ISO-with-offset → trust it.
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(text)) return new Date(text);
  // SQLite "YYYY-MM-DD HH:MM:SS[.fff]" → treat as UTC.
  return new Date(text.replace(" ", "T") + "Z");
}
