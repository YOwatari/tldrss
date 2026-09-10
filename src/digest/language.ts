/** Output languages the digest can be written in. */
export type DigestLanguage = "en" | "ja";

export const DEFAULT_LANGUAGE: DigestLanguage = "en";

/**
 * Languages accepted in the `lang` query parameter. The default is listed too,
 * so a reader can pin the language explicitly instead of relying on the default.
 */
export const DIGEST_LANGUAGES = ["en", "ja"] as const satisfies readonly DigestLanguage[];

export function isDigestLanguage(value: string): value is DigestLanguage {
  return (DIGEST_LANGUAGES as readonly string[]).includes(value);
}
