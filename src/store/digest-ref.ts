import type { DigestLanguage } from "../digest/language";
import type { DigestPeriod } from "../digest/period";

/** Identifies one edition by feed, JST edition date, language and period. */
export type DigestRef = {
  /** `sha256Hex` of the normalized feed url. */
  hash: string;
  /** JST calendar day, `YYYY-MM-DD`. */
  date: string;
  language: DigestLanguage;
  /** Missing on legacy daily digests. */
  period?: DigestPeriod;
};
