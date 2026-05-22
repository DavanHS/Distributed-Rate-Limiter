import type { HeaderSource, RateLimitOptions, RateLimitRequest } from "./types";

/**
 * A minimal logger interface used for warning messages.
 *
 * Defaults to `console` but can be replaced with any logger
 * (winston, pino, bunyan, etc.) that has a `warn` method.
 */
export type KeyResolverLogger = {
  warn(message: string, error?: unknown): void;
};

/**
 * Normalizes a rate limit key by trimming whitespace and converting to lowercase.
 *
 * Applied to all keys (custom resolver output and IP addresses) to ensure
 * consistent bucketing. For example, `" User123 "` and `"user123"` map to
 * the same bucket.
 *
 * @param key - The raw key string to normalize.
 * @returns The normalized key.
 *
 * @example
 * ```ts
 * normalizeKey("  User123  "); // "user123"
 * normalizeKey("API-KEY-ABC"); // "api-key-abc"
 * ```
 */
export function normalizeKey(key: string): string {
  return key.trim().toLowerCase();
}

/**
 * Resolves a client IP address from the request headers.
 *
 * Checks `x-forwarded-for` first (taking the first IP in the chain,
 * which is the original client when behind a trusted proxy), then
 * falls back to `req.ip`.
 *
 * @param req - The rate limit request containing headers and IP.
 * @returns The resolved IP address string.
 *
 * @example
 * ```ts
 * // Request with x-forwarded-for: "203.0.113.50, 70.41.3.18"
 * defaultKeyResolver(req); // "203.0.113.50"
 *
 * // Request without proxy headers
 * defaultKeyResolver(req); // req.ip
 * ```
 */
export function defaultKeyResolver(req: RateLimitRequest): string {
  const forwardedFor = getHeader(req.headers, "x-forwarded-for");
  const forwardedIp = forwardedFor?.split(",")[0]?.trim();

  if (forwardedIp) {
    return forwardedIp;
  }

  return req.ip;
}

/**
 * Resolves a rate limit key from a request, with fallback logic.
 *
 * If a custom `keyResolver` is configured in options, it is invoked first.
 * If it returns a valid non-empty string, that key is normalized and used.
 * If it returns `null`/`undefined`/empty string or throws, a warning is
 * logged and the default IP-based resolver is used as a fallback.
 *
 * This ensures the rate limiter always produces a key — it never blocks
 * a request due to a misconfigured resolver.
 *
 * @param req - The rate limit request.
 * @param options - Configuration containing an optional custom `keyResolver`.
 * @param logger - Logger for warning messages. Defaults to `console`.
 * @returns A normalized rate limit key string.
 *
 * @example
 * ```ts
 * // With custom resolver
 * const key = await resolveKey(req, {
 *   keyResolver: (r) => r.headers.get("authorization")
 * });
 *
 * // Without custom resolver (uses IP)
 * const key = await resolveKey(req, {});
 * ```
 */
export async function resolveKey(
  req: RateLimitRequest,
  options: Pick<RateLimitOptions, "keyResolver"> = {},
  logger: KeyResolverLogger = console,
): Promise<string> {
  if (options.keyResolver) {
    try {
      const customKey = await options.keyResolver(req);
      const normalizedCustomKey = normalizeResolvedKey(customKey);

      if (normalizedCustomKey) {
        return normalizedCustomKey;
      }

      logger.warn("Custom keyResolver returned an empty key. Falling back to IP resolver.");
    } catch (error) {
      logger.warn("Custom keyResolver failed. Falling back to IP resolver.", error);
    }
  }

  return normalizeKey(defaultKeyResolver(req));
}

/**
 * Normalizes a key returned from a custom key resolver.
 *
 * Returns `null` if the key is `null`, `undefined`, or empty after
 * trimming and lowercasing. This signals that the fallback IP resolver
 * should be used.
 *
 * @param key - The raw key from a custom resolver.
 * @returns The normalized key, or `null` if invalid.
 */
function normalizeResolvedKey(key: string | null | undefined): string | null {
  if (key === null || key === undefined) {
    return null;
  }

  const normalizedKey = normalizeKey(key);
  return normalizedKey.length > 0 ? normalizedKey : null;
}

/**
 * Extracts a header value from a `HeaderSource` in a case-insensitive way.
 *
 * Works with standard `Headers`, objects with a `get()` method, and
 * plain records. Handles array values by returning the first element.
 *
 * @param headers - The header source to read from.
 * @param name - The header name (case-insensitive).
 * @returns The header value, or `undefined` if not found.
 */
function getHeader(headers: HeaderSource, name: string): string | undefined {
  if ("get" in headers && typeof headers.get === "function") {
    return headers.get(name) ?? undefined;
  }

  const lowerName = name.toLowerCase();
  const value = Object.entries(headers).find(([key]) => key.toLowerCase() === lowerName)?.[1];

  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}
