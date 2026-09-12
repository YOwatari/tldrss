/** A single, non-expiring heartbeat; its age reveals a Cron that stopped running. */
export const CRON_STATUS_KEY = "health:cron";

export type CronRunSummary = {
  date: string;
  total: number;
  generated: number;
  skipped: number;
  failed: number;
  durationMs: number;
  error?: "invalid_public_origin" | "subscription_read_failed";
};

export type CronStatus = {
  scheduledTime: number;
  completedAt: number;
  summary: CronRunSummary;
};

export async function putCronStatus(cache: KVNamespace, status: CronStatus): Promise<void> {
  await cache.put(CRON_STATUS_KEY, JSON.stringify(status));
}

/** Validate and project the record: /health must never expose arbitrary KV fields. */
export async function getCronStatus(cache: KVNamespace): Promise<CronStatus | null> {
  const stored = await cache.get(CRON_STATUS_KEY);
  if (stored === null) return null;
  let value;
  try {
    value = JSON.parse(stored);
  } catch {
    return null;
  }
  if (!value || !Number.isSafeInteger(value.scheduledTime) || !Number.isSafeInteger(value.completedAt)) return null;
  const summary = value.summary;
  if (!summary || typeof summary.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(summary.date)) return null;
  if (![summary.total, summary.generated, summary.skipped, summary.failed, summary.durationMs]
    .every(count => Number.isSafeInteger(count) && count >= 0)) return null;
  if (summary.error !== undefined && summary.error !== "invalid_public_origin" && summary.error !== "subscription_read_failed") return null;
  return {
    scheduledTime: value.scheduledTime,
    completedAt: value.completedAt,
    summary: {
      date: summary.date, total: summary.total, generated: summary.generated,
      skipped: summary.skipped, failed: summary.failed, durationMs: summary.durationMs,
      ...(summary.error === undefined ? {} : { error: summary.error }),
    },
  };
}
