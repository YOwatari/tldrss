import { jstDate, jstInstant } from "../time";

export const DIGEST_PERIODS = ["daily", "weekly"] as const;
export type DigestPeriod = typeof DIGEST_PERIODS[number];
export type DigestEdition = {
  date: string;
  period: DigestPeriod;
  windowStart: string;
  windowEnd: string;
  publishAt: string;
};
const DAY_MS = 86_400_000;

export function isDigestPeriod(value: string): value is DigestPeriod {
  return DIGEST_PERIODS.some(period => period === value);
}

export function periodDays(period: DigestPeriod = "daily"): number {
  return period === "weekly" ? 7 : 1;
}

/** Weekly editions cover the completed JST calendar week, ending Monday 00:00. */
export function periodDate(now: Date, period: DigestPeriod = "daily"): string {
  const date = jstDate(now);
  if (period === "daily") return date;
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7);
  return day.toISOString().slice(0, 10);
}

/** The edition that is publicly available at `now`. */
export function publishedPeriodDate(now: Date, period: DigestPeriod = "daily"): string {
  const candidate = periodDate(now, period);
  return now.getTime() >= publishAt(candidate, period).getTime() ? candidate : previousPeriodDate(candidate, period);
}

/** The fixed source window for an edition, independent of when it is built. */
export function periodWindow(date: string, period: DigestPeriod = "daily"):
  { start: Date; end: Date; publishAt: Date } {
  if (period === "weekly") {
    const end = jstInstant(date, 0);
    return { start: new Date(end.getTime() - 7 * DAY_MS), end, publishAt: jstInstant(date, 9) };
  }
  const end = jstInstant(date, 8, 50);
  return { start: new Date(end.getTime() - DAY_MS), end, publishAt: jstInstant(date, 9) };
}

/** Full stable edition contract used by both Cron and HTTP generation. */
export function editionOf(date: string, period: DigestPeriod = "daily"): DigestEdition {
  const window = periodWindow(date, period);
  return { date, period, windowStart: window.start.toISOString(), windowEnd: window.end.toISOString(), publishAt: window.publishAt.toISOString() };
}

export function publishAt(date: string, period: DigestPeriod = "daily"): Date {
  return periodWindow(date, period).publishAt;
}

export function nextPeriodDate(date: string, period: DigestPeriod = "daily"): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + periodDays(period) * DAY_MS)
    .toISOString().slice(0, 10);
}

/** The next publication boundary, used to keep edge caches from crossing it. */
export function nextPublicationAt(now: Date, period: DigestPeriod = "daily"): Date {
  const current = periodDate(now, period);
  const currentPublication = publishAt(current, period);
  return now.getTime() < currentPublication.getTime()
    ? currentPublication
    : publishAt(nextPeriodDate(current, period), period);
}

export function previousPeriodDate(date: string, period: DigestPeriod = "daily"): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - periodDays(period) * DAY_MS)
    .toISOString().slice(0, 10);
}

export function periodSuffix(period: DigestPeriod = "daily"): string {
  return period === "daily" ? "" : `:${period}`;
}

/** Cache namespace for the fixed-window contract introduced after v1. */
export function digestCacheSuffix(period: DigestPeriod = "daily"): string {
  return period === "daily" ? ":v2" : periodSuffix(period);
}

export function digestTtlSeconds(period: DigestPeriod = "daily"): number {
  return periodDays(period) * 2 * DAY_MS / 1000;
}
