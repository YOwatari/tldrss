/**
 * The contract between generating a digest and serving it. Everything a
 * reader ever sees is built from these fields, so what is absent matters as
 * much as what is present: the feed url is not here. It is user-supplied and
 * may carry a token, while the xml it would end up in is stored in KV and
 * handed to every subscriber, so the digest is identified by `hash` instead.
 */
import type { FeedEntry } from "../feed/parse";
import type { DigestLanguage } from "./language";

export type Digest = {
  /** `sha256Hex` of the normalized feed url; identifies the feed. */
  hash: string;
  /** JST calendar day the digest covers, `YYYY-MM-DD`. */
  date: string;
  language: DigestLanguage;
  /** Title the source feed gave itself, or its host. */
  feedTitle: string;
  /** Digest body as a sanitized HTML fragment; see `renderDigestHtml`. */
  html: string;
  /** The entries the body was built from, newest first. */
  entries: FeedEntry[];
};

/** The reader-facing addresses of a digest. Neither carries the feed url. */
export type DigestLinks = {
  /** The worker itself, named as the site the channel belongs to. */
  siteUrl: string;
  /** The page carrying the full digest body, `/digest/{hash}/{date}`. */
  pageUrl: string;
};
