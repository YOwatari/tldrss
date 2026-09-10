import type { DigestLanguage } from "../digest/language";

/** Identifies one digest: a feed, the JST day it covers, and its language. */
export type DigestRef = {
  /** `sha256Hex` of the normalized feed url. */
  hash: string;
  /** JST calendar day, `YYYY-MM-DD`. */
  date: string;
  language: DigestLanguage;
};
