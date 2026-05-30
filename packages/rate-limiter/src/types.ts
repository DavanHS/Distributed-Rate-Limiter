import { z } from 'zod';

// Zod schemas (source of truth)
export const TokenBucketOptionsSchema = z.object({
  burst: z.number().int().positive().default(500),
  refillRate: z.number().int().positive().default(50),
  refillInterval: z.number().int().positive().default(1000),
});

export const RedisStoreOptionsSchema = TokenBucketOptionsSchema.extend({
  redisUrl: z.string().url(),
  failOpen: z.boolean().default(true),
});

// Inferred types from Zod schemas
export type TokenBucketOptions = z.infer<typeof TokenBucketOptionsSchema>;
export type RedisStoreOptions = z.infer<typeof RedisStoreOptionsSchema>;

// Core interfaces
export interface CheckResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetTime: number;   // Absolute Unix epoch timestamp in ms
  retryAfter: number;  // Relative seconds until next token (0 if allowed)
}

export interface RateLimitStore {
  check(key: string): Promise<CheckResult>;
  shutdown(): Promise<void>;
}

export interface Logger {
  warn(message: string, context?: unknown): void;
  error(message: string, context?: unknown): void;
}

export interface RateLimitResponse {
  allowed: boolean;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

export type RateLimitMiddleware = (
  key: string,
  next: () => Promise<void>,
) => Promise<RateLimitResponse>;
