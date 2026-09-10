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

/** Hour of the JST morning a digest is dated at, matching the cron run. */
const DIGEST_HOUR_JST = "09:00:00";

const RFC822_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const RFC822_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * The `<pubDate>` of the digest covering `date`: 09:00:00 JST of that day, in
 * the RFC 822 form RSS 2.0 asks for (`Thu, 10 Sep 2026 09:00:00 +0900`).
 *
 * A fixed hour rather than the generation time: readers sort and display by
 * this field, so a digest must not appear to have been published at whatever
 * minute the cron run happened to finish. It is formatted by hand because
 * `toUTCString` would move the day back for anything before 09:00 JST.
 */
export function digestPubDate(date: string): string {
  // Midnight UTC of the same calendar day, read back with the UTC getters, so
  // the weekday named is the one of the JST day rather than of an instant.
  const day = new Date(Date.parse(`${date}T00:00:00Z`));
  if (Number.isNaN(day.getTime())) {
    throw new Error(`Not a calendar date: ${date}`);
  }

  const weekday = RFC822_WEEKDAYS[day.getUTCDay()];
  const dayOfMonth = String(day.getUTCDate()).padStart(2, "0");
  const month = RFC822_MONTHS[day.getUTCMonth()];

  return `${weekday}, ${dayOfMonth} ${month} ${day.getUTCFullYear()} ${DIGEST_HOUR_JST} +0900`;
}
