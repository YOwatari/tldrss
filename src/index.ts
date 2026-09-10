import type { Env } from "./env";
import { handleFeed } from "./handlers/feed";
import { createWorkersAiSummarizer } from "./llm/workers-ai";

export type { Env };

const USAGE = [
  "tldrss - a daily RSS digest proxy.",
  "",
  "GET /feed?url=<feed url>[&lang=en|ja]",
].join("\n");

/** Readers only ever read, and generation is too costly to let anyone POST. */
const SERVED_METHODS = ["GET", "HEAD"];

const ROUTES = ["/feed", "/"];

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);

    // Path first: 405 says the resource exists but refuses the method, which
    // would be a lie about a path this worker does not serve at all.
    if (!ROUTES.includes(pathname)) {
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

    // Doubles as the health check: a plain 200 with no binding access.
    return new Response(USAGE, { headers: { "content-type": "text/plain; charset=utf-8" } });
  },
} satisfies ExportedHandler<Env>;
