export class RateLimiterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimiterError';
  }
}

export class RedisLimiterInitError extends RateLimiterError {
  constructor(message: string) {
    super(message);
    this.name = 'RedisLimiterInitError';
  }
}
