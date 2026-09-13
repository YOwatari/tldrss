/** Errors raised while acquiring an upstream feed. */
export class FeedFetchError extends Error {
  constructor(message: string, readonly code: "timeout" | "too_large" | "http" | "body" | "policy" | "redirect") {
    super(message);
    this.name = "FeedFetchError";
  }
}

export type FeedFetcherOptions = {
  timeoutMs: number;
  maxBytes: number;
  /** An absolute generation deadline, shared with later pipeline stages. */
  deadlineAt?: number;
  /** Validates every URL, including redirect targets. */
  isAllowed?: (url: URL) => boolean;
  maxRedirects?: number;
};

/** Fetches an upstream feed with one deadline and a streaming byte limit. */
export async function fetchFeed(url: URL, options: FeedFetcherOptions): Promise<string> {
  const startedAt = Date.now();
  const deadlineAt = Math.min(
    startedAt + options.timeoutMs,
    options.deadlineAt ?? Number.POSITIVE_INFINITY,
  );
  const controller = new AbortController();
  const remaining = () => Math.max(0, deadlineAt - Date.now());

  try {
    if (remaining() <= 0) throw new FeedFetchError("Upstream feed timed out", "timeout");
    let response: Response;
    let currentUrl = new URL(url.toString());
    const isAllowed = options.isAllowed ?? (() => true);
    const maxRedirects = options.maxRedirects ?? 5;
    for (let redirectCount = 0; ; redirectCount += 1) {
      if (!isAllowed(currentUrl)) throw new FeedFetchError("Feed destination is not allowed", "policy");
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const request = fetch(currentUrl.toString(), { signal: controller.signal, redirect: "manual" });
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new FeedFetchError("Upstream feed timed out", "timeout"));
          }, remaining());
        });
        try {
          response = await Promise.race([request, timeout]);
        } finally {
          clearTimeout(timer);
        }
      } catch (error) {
        if (controller.signal.aborted) throw new FeedFetchError("Upstream feed timed out", "timeout");
        throw error;
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      if (!location) throw new FeedFetchError("Feed redirect did not provide a location", "redirect");
      if (redirectCount >= maxRedirects) throw new FeedFetchError("Feed redirected too many times", "redirect");
      try {
        currentUrl = new URL(location, currentUrl);
      } catch {
        throw new FeedFetchError("Feed redirect location was invalid", "redirect");
      }
    }
    if (!response.ok) throw new FeedFetchError(`Feed responded with ${response.status}`, "http");
    if (!response.body) {
      throw new FeedFetchError("Upstream feed did not provide a body", "body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    let bytes = 0;
    try {
      while (true) {
        if (remaining() <= 0) throw new FeedFetchError("Upstream feed timed out", "timeout");
        const read = reader.read();
        let readTimer: ReturnType<typeof setTimeout> | undefined;
        const readDeadline = new Promise<never>((_, reject) => {
          readTimer = setTimeout(() => {
            controller.abort();
            void reader.cancel("feed read timed out").catch(() => undefined);
            reject(new FeedFetchError("Upstream feed timed out", "timeout"));
          }, remaining());
        });
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await Promise.race([read, readDeadline]);
        } finally {
          clearTimeout(readTimer);
        }
        if (controller.signal.aborted) {
          throw new FeedFetchError("Upstream feed timed out", "timeout");
        }
        const { done, value } = result;
        if (done) break;
        bytes += value.byteLength;
        if (bytes > options.maxBytes) {
          // Cancellation is best effort. The size error must be observable
          // immediately even if an unusual underlying stream never settles
          // its cancel promise.
          void reader.cancel("feed too large").catch(() => undefined);
          throw new FeedFetchError(`Upstream feed exceeded ${options.maxBytes} bytes`, "too_large");
        }
        chunks.push(decoder.decode(value, { stream: true }));
      }
      chunks.push(decoder.decode());
    } catch (error) {
      if (controller.signal.aborted) throw new FeedFetchError("Upstream feed timed out", "timeout");
      throw error;
    } finally {
      reader.releaseLock();
    }
    return chunks.join("");
  } finally {
    if (!controller.signal.aborted) controller.abort();
  }
}
