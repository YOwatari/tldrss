import { jstDate } from "../time";

export const DIGEST_PERIODS = ["daily", "weekly"] as const;
export type DigestPeriod = typeof DIGEST_PERIODS[number];
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

export function previousPeriodDate(date: string, period: DigestPeriod = "daily"): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - periodDays(period) * DAY_MS)
    .toISOString().slice(0, 10);
}

export function periodSuffix(period: DigestPeriod = "daily"): string {
  return period === "daily" ? "" : `:${period}`;
}

export function digestTtlSeconds(period: DigestPeriod = "daily"): number {
  return periodDays(period) * 2 * DAY_MS / 1000;
}
