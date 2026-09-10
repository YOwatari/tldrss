/**
 * The RSS 2.0 feed Slack subscribes to.
 *
 * Slack posts one message per new `<guid>`, so the shape here is what decides
 * whether a subscriber gets one digest a day or several: at most one `<item>`
 * per feed, its guid stable for the day, its `<pubDate>` fixed to the JST
 * morning rather than to whenever generation finished.
 */
import { channelTitleText, channelDescriptionText, itemTitleText } from "./text";
import { DEFAULT_LANGUAGE, type DigestLanguage } from "./language";
import type { Digest, DigestLinks } from "./types";
import { digestPubDate } from "../time";

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * Wraps the digest body in a CDATA section so the reader receives html rather
 * than escaped text.
 *
 * A body containing `]]>` would end the section early and spill markup into
 * the document, so each occurrence is split across two sections: the first
 * ends after `]]`, the second opens with the `>`.
 */
function cdata(html: string): string {
  return `<![CDATA[${html.replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;
}

/**
 * The channel head, shared by the digest feed and the item-less one. The atom
 * namespace is declared for `<atom:link rel="self">`, which feed validators
 * expect and which tells a reader where the feed lives.
 */
function channelHead(params: {
  feedTitle: string;
  language: DigestLanguage;
  links: DigestLinks;
  now: Date;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(channelTitleText(params.feedTitle, params.language))}</title>
    <link>${escapeXml(params.links.feedUrl)}</link>
    <description>${escapeXml(channelDescriptionText(params.feedTitle, params.language))}</description>
    <atom:link rel="self" type="application/rss+xml" href="${escapeXml(params.links.feedUrl)}" />
    <lastBuildDate>${params.now.toUTCString()}</lastBuildDate>`;
}

const CHANNEL_TAIL = `  </channel>
</rss>`;

/** The feed carrying one day's digest: exactly one `<item>`. */
export function buildDigestXml(params: {
  digest: Digest;
  links: DigestLinks;
  now?: Date;
}): string {
  const { digest, links } = params;
  const now = params.now ?? new Date();
  // Built from the hash rather than the feed url: the guid travels to every
  // reader, and a feed url can carry a token in its query string.
  // Readers deduplicate by guid, so the languages must not share one: two
  // subscriptions to the same feed would otherwise collapse into one item.
  const guid = `${digest.hash}-${digest.date}-${digest.language}`;

  return `${channelHead({
    feedTitle: digest.feedTitle,
    language: digest.language,
    links,
    now,
  })}
    <item>
      <title>${escapeXml(itemTitleText(digest.feedTitle, digest.date, digest.language))}</title>
      <link>${escapeXml(links.pageUrl)}</link>
      <guid isPermaLink="false">${escapeXml(guid)}</guid>
      <pubDate>${digestPubDate(digest.date)}</pubDate>
      <description>${cdata(digest.html)}</description>
    </item>
${CHANNEL_TAIL}`;
}

/**
 * A valid RSS 2.0 channel with no `<item>`, served while the digest of the day
 * is still being generated, and on a day the feed published nothing (unless
 * `POST_NO_UPDATES` asks for a digest saying so). It is well-formed and
 * carries no entry, so a reader treats the crawl as an ordinary empty feed
 * and posts nothing.
 */
export function buildEmptyChannelXml(params: {
  feedTitle: string;
  language?: DigestLanguage;
  links: DigestLinks;
  now?: Date;
}): string {
  return `${channelHead({
    feedTitle: params.feedTitle,
    language: params.language ?? DEFAULT_LANGUAGE,
    links: params.links,
    now: params.now ?? new Date(),
  })}
${CHANNEL_TAIL}`;
}
