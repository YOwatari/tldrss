import type { FeedEntry } from "../feed/parse";

export function buildDigestPrompt(feedTitle: string, entries: FeedEntry[]): string {
  const lines = entries.map((entry, index) => {
    const title = entry.title ?? "(untitled)";
    const link = entry.link ?? "";
    const snippet = entry.contentSnippet ?? entry.content ?? "";
    return `${index + 1}. ${title}\nURL: ${link}\nExcerpt: ${snippet}`;
  });

  return [
    `Create a concise daily digest of the following RSS entries from \"${feedTitle}\".`,
    "Keep it brief (4-8 bullet points), factual, and easy to scan.",
    "",
    ...lines,
  ].join("\n");
}

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
  summary: string;
  now?: Date;
}): string {
  const now = params.now ?? new Date();
  const digestTitle = `Daily Digest: ${params.feedTitle}`;
  const digestGuid = `${params.feedUrl}#${now.toISOString().slice(0, 10)}`;
  const description = escapeXml(params.summary).replaceAll("\n", "&#10;");

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
