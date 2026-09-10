/**
 * Hex-encoded SHA-256 of `text`.
 *
 * Feed URLs are user-supplied and may carry credentials, so they are hashed
 * before they become part of a cache key or a public identifier.
 */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
