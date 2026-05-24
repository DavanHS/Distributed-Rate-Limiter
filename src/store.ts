import type { CheckResult } from "./types";

export interface RateLimitStore {
  check(key: string): Promise<CheckResult>;
}
