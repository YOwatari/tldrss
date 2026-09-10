import type { Env } from "./env";
import { handleFeed } from "./handlers/feed";

export type { Env };

const USAGE = [
  "tldrss - a daily RSS digest proxy.",
  "",
  "GET /feed?url=<feed url>[&lang=en|ja]",
].join("\n");

/** Readers only ever read, and generation is too costly to let anyone POST. */
const SERVED_METHODS = ["GET", "HEAD"];

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (!SERVED_METHODS.includes(request.method)) {
      return new Response("Method not allowed", {
        status: 405,
        headers: { allow: SERVED_METHODS.join(", ") },
      });
    }

    if (pathname === "/feed") return handleFeed(request, env, ctx);

    // Doubles as the health check: a plain 200 with no binding access.
    if (pathname === "/") {
      return new Response(USAGE, { headers: { "content-type": "text/plain; charset=utf-8" } });
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
