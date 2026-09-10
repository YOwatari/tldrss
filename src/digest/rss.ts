function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function buildRssXml(params: {
  requestUrl: string;
  feedUrl: string;
  feedTitle: string;
  /** Digest body as an HTML fragment; see `renderDigestHtml`. */
  summaryHtml: string;
  now?: Date;
}): string {
  const now = params.now ?? new Date();
  const digestTitle = `Daily Digest: ${params.feedTitle}`;
  const digestGuid = `${params.feedUrl}#${now.toISOString().slice(0, 10)}`;
  // The body is HTML nested in an XML element, so it is escaped once more here.
  const description = escapeXml(params.summaryHtml);

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(digestTitle)}</title>
    <link>${escapeXml(params.requestUrl)}</link>
    <description>${escapeXml(`Daily digest for ${params.feedTitle}`)}</description>
    <item>
      <title>${escapeXml(digestTitle)}</title>
      <link>${escapeXml(params.requestUrl)}</link>
      <guid isPermaLink="false">${escapeXml(digestGuid)}</guid>
      <pubDate>${now.toUTCString()}</pubDate>
      <description>${description}</description>
    </item>
  </channel>
</rss>`;
}
