import type { Env } from "./env";
import { handleDigestPage } from "./handlers/digest-page";
import { handleFeed } from "./handlers/feed";
import { createWorkersAiSummarizer } from "./llm/workers-ai";

export type { Env };

const USAGE = [
  "tldrss - a daily RSS digest proxy.",
  "",
  "GET /feed?url=<feed url>[&lang=en|ja]",
  "GET /digest/<feed hash>/<YYYY-MM-DD>[?lang=en|ja]",
].join("\n");

/** Readers only ever read, and generation is too costly to let anyone POST. */
const SERVED_METHODS = ["GET", "HEAD"];

const ROUTES = ["/feed", "/"];

/**
 * Digest pages, whose path carries the digest it serves. The handler decides
 * whether a given path under this prefix names a digest at all.
 */
const DIGEST_PAGE_PREFIX = "/digest/";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);

    // Path first: 405 says the resource exists but refuses the method, which
    // would be a lie about a path this worker does not serve at all.
    if (!ROUTES.includes(pathname) && !pathname.startsWith(DIGEST_PAGE_PREFIX)) {
      return new Response("Not found", { status: 404 });
    }

    if (!SERVED_METHODS.includes(request.method)) {
      return new Response("Method not allowed", {
        status: 405,
        headers: { allow: SERVED_METHODS.join(", ") },
      });
    }

    // The composition root is the only place that names a model provider;
    // everything downstream sees a `Summarizer`.
    if (pathname === "/feed") {
      const summarizer = createWorkersAiSummarizer({ ai: env.AI, model: env.AI_MODEL });

      return handleFeed(request, env, ctx, summarizer);
    }

    if (pathname.startsWith(DIGEST_PAGE_PREFIX)) {
      return handleDigestPage(request, env);
    }

    // Doubles as the health check: a plain 200 with no binding access.
    return new Response(USAGE, { headers: { "content-type": "text/plain; charset=utf-8" } });
  },
} satisfies ExportedHandler<Env>;
