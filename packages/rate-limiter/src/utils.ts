import type { CheckResult } from './types.js';

export function getRateLimitDetails(result: CheckResult) {
  return {
    headers: {
      'X-RateLimit-Limit': String(result.limit),
      'X-RateLimit-Remaining': String(result.remaining),
      ...(result.allowed ? {} : { 'Retry-After': String(result.retryAfter) }),
    },
    body: result.allowed ? null : {
      error: 'rate_limit_exceeded',
      message: 'Too many requests. Please wait.',
      retryAfter: result.retryAfter,
    },
  };
}
