import { type Env, publicOriginOf } from "../env";
import { getCronStatus, type CronStatus } from "../store/cron-status";

const DAY_MS = 24 * 60 * 60 * 1000;
// Must match `50 23 * * *` in wrangler.toml. Allow 15 minutes to finish and
// propagate through KV before declaring this morning's run missing.
const SCHEDULE_OFFSET_MS = (23 * 60 + 50) * 60 * 1000;
const GRACE_MS = 15 * 60 * 1000;

export async function handleHealth(request: Request, env: Env): Promise<Response> {
  let cron: CronStatus | null = null;
  let reason: string | undefined;
  if (!publicOriginOf(env)) {
    reason = "invalid_public_origin";
  } else {
    try {
      cron = await getCronStatus(env.DIGEST_CACHE);
      const now = Date.now();
      const expected = Math.floor((now - GRACE_MS - SCHEDULE_OFFSET_MS) / DAY_MS) * DAY_MS + SCHEDULE_OFFSET_MS;
      if (!cron) reason = "cron_missing";
      else if (cron.scheduledTime > now || cron.completedAt > now) reason = "cron_invalid";
      else if (cron.summary.error || cron.summary.failed > 0) reason = "cron_failed";
      else if (cron.scheduledTime < expected) reason = "cron_stale";
    } catch {
      reason = "storage_unavailable";
    }
  }

  const body = { status: reason ? "error" : "ok", ...(reason ? { reason } : {}), ...(cron ? { cron } : {}) };
  return new Response(request.method === "HEAD" ? null : JSON.stringify(body), {
    status: reason ? 503 : 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
