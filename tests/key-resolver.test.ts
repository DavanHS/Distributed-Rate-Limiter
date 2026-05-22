import { describe, expect, mock, test } from "bun:test";
import {
  defaultKeyResolver,
  normalizeKey,
  resolveKey,
  type KeyResolverLogger,
} from "../src/key-resolver";
import type { RateLimitRequest } from "../src/types";

function request(headers: RateLimitRequest["headers"], ip = "203.0.113.10"): RateLimitRequest {
  return { headers, ip };
}

describe("normalizeKey", () => {
  test("trims whitespace and lowercases keys", () => {
    expect(normalizeKey("  User:ABC123  ")).toBe("user:abc123");
  });
});

describe("defaultKeyResolver", () => {
  test("uses the first x-forwarded-for IP when present", () => {
    const req = request(new Headers({ "x-forwarded-for": "198.51.100.7, 198.51.100.8" }));

    expect(defaultKeyResolver(req)).toBe("198.51.100.7");
  });

  test("falls back to req.ip when x-forwarded-for is absent", () => {
    const req = request(new Headers());

    expect(defaultKeyResolver(req)).toBe("203.0.113.10");
  });

  test("supports plain header objects with case-insensitive names", () => {
    const req = request({ "X-Forwarded-For": "198.51.100.9" });

    expect(defaultKeyResolver(req)).toBe("198.51.100.9");
  });
});

describe("resolveKey", () => {
  test("uses a custom keyResolver when it returns a valid key", async () => {
    const req = request(new Headers(), "203.0.113.10");

    await expect(resolveKey(req, { keyResolver: () => "  USER:42  " })).resolves.toBe("user:42");
  });

  test("falls back to default IP resolver and warns when custom keyResolver returns empty", async () => {
    const req = request(new Headers({ "x-forwarded-for": "198.51.100.7" }));
    const logger: KeyResolverLogger = { warn: mock() };

    await expect(resolveKey(req, { keyResolver: () => "   " }, logger)).resolves.toBe("198.51.100.7");
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  test("falls back to default IP resolver and warns when custom keyResolver returns null", async () => {
    const req = request(new Headers(), "203.0.113.10");
    const logger: KeyResolverLogger = { warn: mock() };

    await expect(resolveKey(req, { keyResolver: () => null }, logger)).resolves.toBe("203.0.113.10");
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  test("falls back to default IP resolver and warns when custom keyResolver returns undefined", async () => {
    const req = request(new Headers(), "203.0.113.10");
    const logger: KeyResolverLogger = { warn: mock() };

    await expect(resolveKey(req, { keyResolver: () => undefined }, logger)).resolves.toBe("203.0.113.10");
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  test("falls back to default IP resolver and warns when custom keyResolver throws", async () => {
    const req = request(new Headers(), "203.0.113.10");
    const logger: KeyResolverLogger = { warn: mock() };

    await expect(
      resolveKey(
        req,
        {
          keyResolver: () => {
            throw new Error("boom");
          },
        },
        logger,
      ),
    ).resolves.toBe("203.0.113.10");
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
