import type { Context, MiddlewareHandler, Next } from "hono";
import { getSignedCookie, setSignedCookie } from "hono/cookie";
import type { RateLimitMiddleware } from "./types";

const RATE_LIMIT_COOKIE_NAME = "__rl_id";
const RATE_LIMIT_COOKIE_SECRET_ENV = "RATE_LIMIT_COOKIE_SECRET";
const RATE_LIMIT_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
  path: "/",
} as const;

export function createHonoMiddleware(limiter: RateLimitMiddleware): MiddlewareHandler {
  const secret = getCookieSecret();

  return async (c: Context, next: Next) => {
    const identity = await resolveCookieIdentity(c, secret);

    if (identity.shouldSetCookie) {
      await setSignedCookie(
        c,
        RATE_LIMIT_COOKIE_NAME,
        identity.key,
        secret,
        RATE_LIMIT_COOKIE_OPTIONS,
      );
    }

    const response = await limiter(identity.key, async () => {
      await next();
      return c.res;
    });

    if (!response) {
      return;
    }

    if (response.status === 429) {
      c.status(429);
      return c.json(await response.json(), 429, responseHeadersToRecord(response.headers));
    }

    c.res = response;
    return response;
  };
}

function responseHeadersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};

  for (const [key, value] of headers.entries()) {
    record[key] = value;
  }

  return record;
}

type CookieIdentity = {
  key: string;
  shouldSetCookie: boolean;
};

async function resolveCookieIdentity(c: Context, secret: string): Promise<CookieIdentity> {
  const verifiedKey = await getSignedCookie(c, secret, RATE_LIMIT_COOKIE_NAME);

  if (typeof verifiedKey === "string" && verifiedKey.length > 0) {
    return { key: verifiedKey, shouldSetCookie: false };
  }

  return {
    key: crypto.randomUUID(),
    shouldSetCookie: true,
  };
}

function getCookieSecret(): string {
  const secret = process.env[RATE_LIMIT_COOKIE_SECRET_ENV]?.trim();

  if (!secret) {
    throw new Error(`${RATE_LIMIT_COOKIE_SECRET_ENV} is required.`);
  }

  return secret;
}
