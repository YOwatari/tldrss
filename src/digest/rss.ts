import type { DigestLanguage } from "./language";

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function digestTitleOf(feedTitle: string): string {
  return `Daily Digest: ${feedTitle}`;
}

/**
 * A valid RSS 2.0 channel with no `<item>`, served while the digest of the day
 * is still being generated. It is well-formed and carries no entry, so the
 * intent is that a reader treats the first crawl as an ordinary empty feed
 * rather than an error; how Slack actually reacts is still to be confirmed
 * (see issue #9).
 */
export function buildEmptyChannelXml(params: {
  /** Worker url shown to readers; must not carry the feed url. */
  publicUrl: string;
  feedTitle: string;
}): string {
  const digestTitle = digestTitleOf(params.feedTitle);

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(digestTitle)}</title>
    <link>${escapeXml(params.publicUrl)}</link>
    <description>${escapeXml(`Daily digest for ${params.feedTitle}`)}</description>
  </channel>
</rss>`;
}

export function buildRssXml(params: {
  /** Worker url shown to readers; must not carry the feed url. */
  publicUrl: string;
  /** `sha256Hex` of the feed url; identifies the feed without exposing it. */
  feedHash: string;
  /** JST day the digest covers, `YYYY-MM-DD`. */
  digestDate: string;
  feedTitle: string;
  /** Digest body as an HTML fragment; see `renderDigestHtml`. */
  summaryHtml: string;
  language: DigestLanguage;
  now?: Date;
}): string {
  const now = params.now ?? new Date();
  const digestTitle = digestTitleOf(params.feedTitle);
  // Built from the hash rather than the feed url: the guid travels to every
  // reader, and a feed url can carry a token in its query string.
  // Readers deduplicate by guid, so the languages must not share one: two
  // subscriptions to the same feed would otherwise collapse into one item.
  const digestGuid = `${params.feedHash}-${params.digestDate}-${params.language}`;
  // The body is HTML nested in an XML element, so it is escaped once more here.
  const description = escapeXml(params.summaryHtml);

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(digestTitle)}</title>
    <link>${escapeXml(params.publicUrl)}</link>
    <description>${escapeXml(`Daily digest for ${params.feedTitle}`)}</description>
    <item>
      <title>${escapeXml(digestTitle)}</title>
      <link>${escapeXml(params.publicUrl)}</link>
      <guid isPermaLink="false">${escapeXml(digestGuid)}</guid>
      <pubDate>${now.toUTCString()}</pubDate>
      <description>${description}</description>
    </item>
  </channel>
</rss>`;
}
