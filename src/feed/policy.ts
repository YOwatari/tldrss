import type { Env } from "../env";

export const MAX_FEED_REDIRECTS = 5;

/** Destination policy is independent from the caller's token authentication. */
export function isFeedDestinationAllowed(env: Env, url: URL): boolean {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.port && url.port !== (url.protocol === "http:" ? "80" : "443")) return false;

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "local") return false;
  if (isPrivateIp(hostname)) return false;

  const hosts = (env.ALLOWED_FEED_HOSTS ?? "").split(",")
    .map(host => host.trim().toLowerCase().replace(/\.$/, "")).filter(Boolean);
  return hosts.length === 0 || hosts.includes(hostname);
}

function isPrivateIp(hostname: string): boolean {
  if (hostname.includes(":")) {
    const value = hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return value === "::1" || value === "::" || value.startsWith("fc") || value.startsWith("fd") || /^fe[89ab]/.test(value);
  }
  const parts = hostname.split(".");
  const octets = parts.map(Number);
  if (parts.length !== 4 || octets.some((octet, index) => !Number.isInteger(octet) || octet < 0 || octet > 255 || parts[index] !== String(octet))) return false;
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

/** User authentication plus the initial destination check for /feed. */
export function isFeedRequestAuthorized(env: Env, feed: URL, token: string | null): boolean {
  return isFeedDestinationAllowed(env, feed) && (!env.FEED_TOKEN || token === env.FEED_TOKEN);
}
