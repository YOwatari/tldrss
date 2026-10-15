/**
 * GET /digest/{hash}/{date}?lang=<en|ja>
 *
 * The full text of one digest. Slack truncates an item's body, so the item
 * links here; the page is what a reader actually reads. The address is built
 * from the feed hash rather than the feed url, so it can be handed out
 * without exposing a private feed's credentials.
 */
import { renderDigestBodyHtml } from "../digest/html";
import { itemTitleText } from "../digest/text";
import {
  DEFAULT_LANGUAGE,
  DIGEST_LANGUAGES,
  type DigestLanguage,
  isDigestLanguage,
} from "../digest/language";
import type { Env } from "../env";
import { getDigestPage, isLegacyDigestPage, type StoredDigestPage } from "../store/digest-page";
import type { DigestRef } from "../store/digest-ref";
import { isDigestPeriod } from "../digest/period";

/** `/digest/{sha256 hex}/{YYYY-MM-DD}`, and nothing else. */
const PATH_PATTERN = /^\/digest\/([0-9a-f]{64})\/(\d{4}-\d{2}-\d{2})$/;

/**
 * A day's digest never changes once written, so an hour of edge caching is
 * safe. It is not `immutable`: a reader following the link the morning of a
 * failed generation should see the digest once it lands.
 */
const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "public, max-age=3600",
  // The body is escaped already; this is the second line of defence, and it
  // also keeps a digest from pulling in anything over the network.
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
  "x-content-type-options": "nosniff",
  // The path carries the feed hash, so it must not reach the linked articles.
  "referrer-policy": "no-referrer",
};

/** Enough styling to make the digest readable on a phone, and no more. */
const STYLE = `
  :root { color-scheme: light dark; }
  body {
    margin: 0 auto;
    padding: 1.5rem 1.25rem 4rem;
    max-width: 42rem;
    font-family: system-ui, sans-serif;
    line-height: 1.7;
  }
  h1 { font-size: 1.375rem; line-height: 1.4; }
  ul { padding-left: 1.25rem; }
  li { margin-bottom: 1rem; }
  a { color: #0b6bcb; }
  @media (prefers-color-scheme: dark) { a { color: #79b8ff; } }
`;

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function notFound(): Response {
  return new Response("Not found", { status: 404 });
}

/**
 * The digest as a standalone page: the lead, then every selected entry linked
 * to its article.
 *
 * A record from before the page was stored as data carries its body as html
 * that left the sanitizer, and is inserted as it is: escaping it would show
 * the reader tags instead of a digest. Those records expire with their TTL.
 */
function renderPage(page: StoredDigestPage, ref: DigestRef): string {
  const title = escapeHtml(itemTitleText(page.feedTitle, ref.date, ref.language, ref.period));
  const body = isLegacyDigestPage(page)
    ? page.html
    : renderDigestBodyHtml({ ...page, language: ref.language });

  return `<!DOCTYPE html>
<html lang="${ref.language}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${title}</title>
<style>${STYLE}</style>
</head>
<body>
<h1>${title}</h1>
${body}
</body>
</html>`;
}

export async function handleDigestPage(request: Request, env: Env): Promise<Response> {
  const requestUrl = new URL(request.url);

  // A path of another shape is not a digest that is missing, it is not a
  // digest address at all, so it gets the same answer as an unknown path.
  const match = PATH_PATTERN.exec(requestUrl.pathname);
  if (!match) return notFound();

  const requestedLanguage = requestUrl.searchParams.get("lang");
  if (requestedLanguage !== null && !isDigestLanguage(requestedLanguage)) {
    return new Response(
      `Unsupported lang query parameter. Supported: ${DIGEST_LANGUAGES.join(", ")}`,
      { status: 400 },
    );
  }
  const language: DigestLanguage = requestedLanguage ?? DEFAULT_LANGUAGE;

  const period = requestUrl.searchParams.get("period") ?? "daily";
  if (!isDigestPeriod(period)) {
    return new Response("Unsupported period query parameter. Supported: daily, weekly", { status: 400 });
  }
  const ref: DigestRef = { hash: match[1], date: match[2], language, period };

  const page = await getDigestPage(env.DIGEST_CACHE, ref);
  if (!page) return notFound();

  return new Response(renderPage(page, ref), { headers: HTML_HEADERS });
}
