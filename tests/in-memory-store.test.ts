import { describe, expect, test } from "bun:test";
import { InMemoryStore } from "../src/in-memory-store";

type StoreInternals = {
  store: Map<string, { tokens: number; lastRefill: number }>;
};

async function withMockedNow<T>(now: number, fn: () => Promise<T>): Promise<T> {
  const originalDateNow = Date.now;
  Date.now = () => now;

  try {
    return await fn();
  } finally {
    Date.now = originalDateNow;
  }
}

describe("InMemoryStore", () => {
  test("uses default burst and refill settings", async () => {
    const store = new InMemoryStore();

    await withMockedNow(1_700_000_000_000, async () => {
      const result = await store.check("client");

      expect(result).toEqual({
        allowed: true,
        limit: 500,
        remaining: 499,
        resetTime: 1_700_000_001_000,
        retryAfter: 0,
      });
    });
  });

  test("exhausts burst, clamps remaining to zero, and refills by interval", async () => {
    const store = new InMemoryStore({ burst: 2, refillRate: 1, refillInterval: 1000 });

    await withMockedNow(1_700_000_000_000, async () => {
      expect(await store.check("client")).toMatchObject({ allowed: true, remaining: 1 });
      expect(await store.check("client")).toMatchObject({ allowed: true, remaining: 0 });
      expect(await store.check("client")).toMatchObject({ allowed: false, remaining: 0 });
    });

    await withMockedNow(1_700_000_001_000, async () => {
      expect(await store.check("client")).toMatchObject({ allowed: true, remaining: 0 });
    });
  });

  test("keeps opaque keys exact with rl prefix", async () => {
    const store = new InMemoryStore({ burst: 1, refillRate: 1, refillInterval: 60_000 });

    await withMockedNow(1_700_000_000_000, async () => {
      expect(await store.check("  USER:42  ")).toMatchObject({ allowed: true });
      expect(await store.check("user:42")).toMatchObject({ allowed: true });
    });

    const internals = store as unknown as StoreInternals;
    expect([...internals.store.keys()]).toEqual(["rl:  USER:42  ", "rl:user:42"]);
  });

  test("cleans expired entries even when they appear after non-expired entries", async () => {
    const store = new InMemoryStore({ burst: 2, refillRate: 1, refillInterval: 1000 });

    await withMockedNow(1_700_000_000_000, async () => {
      await store.check("older");
    });
    await withMockedNow(1_700_000_001_500, async () => {
      await store.check("newer");
      await store.check("older");
    });
    await withMockedNow(1_700_000_003_001, async () => {
      await store.check("third");
    });

    const internals = store as unknown as StoreInternals;
    expect(internals.store.has("rl:older")).toBe(false);
    expect(internals.store.has("rl:newer")).toBe(true);
    expect(internals.store.has("rl:third")).toBe(true);
  });

  test("evicts least-recently-used key when max key count is exceeded", async () => {
    const store = new InMemoryStore({ burst: 1, refillRate: 1, refillInterval: 60_000 });

    await withMockedNow(1_700_000_000_000, async () => {
      for (let i = 0; i <= 10_000; i += 1) {
        await store.check(`client-${i}`);
      }
    });

    const internals = store as unknown as StoreInternals;
    expect(internals.store.size).toBe(10_000);
    expect(internals.store.has("rl:client-0")).toBe(false);
    expect(internals.store.has("rl:client-10000")).toBe(true);
  });
});
