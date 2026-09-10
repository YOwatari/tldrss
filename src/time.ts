/** Offset of Asia/Tokyo from UTC. JST has no daylight saving time. */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` of the JST calendar day `now` falls on. */
export function jstDate(now: Date = new Date()): string {
  return new Date(now.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The `YYYY-MM-DD` calendar day before `date`. */
export function previousDate(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
}
