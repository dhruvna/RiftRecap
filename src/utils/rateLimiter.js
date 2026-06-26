// === Token bucket ===
// A simple token bucket implementation used to enforce API rate limits.

class TokenBucket {
  constructor({ capacity, refillPerMs }) {
    this.capacity = capacity;
    this.refillPerMs = refillPerMs;
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  // Refill tokens based on elapsed time since the last refill.
  refill(now = Date.now()) {
    const elapsed = Math.max(0, now - this.lastRefill);
    if (elapsed <= 0) return;

    const add = elapsed * this.refillPerMs;
    if (add > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + add);
      this.lastRefill = now;
    }
  }

  // Compute how long until at least one token is available.
  get waitMsForToken() {
    if (this.tokens >= 1) return 0;
    const deficit = 1 - this.tokens;
    return Math.ceil(deficit / this.refillPerMs);
  }

  // Empty the bucket and restart refill timing from now. Used after upstream
  // rate-limit responses so queued callers do not immediately retry as a burst.
  drain(now = Date.now()) {
    this.tokens = 0;
    this.lastRefill = now;
  }
}

// === Composite rate limiter ===
// Combines multiple buckets so all constraints must be satisfied.
class CompositeRateLimiter {
  constructor(buckets = []) {
    this.buckets = buckets;
    this.blockedUntil = 0;
  }

  canConsume(count = 1, now = Date.now()) {
    if (now < this.blockedUntil) return false;
    return this.buckets.every((bucket) => {
      bucket.refill(now);
      return bucket.tokens >= count;
    });
  }

  consume(count = 1) {
    for (const bucket of this.buckets) {
      bucket.tokens -= count;
    }
  }
  
  get waitMsForCooldown() {
    return Math.max(0, this.blockedUntil - Date.now());
  }

  // Penalize the limiter after a 429. Riot can return a Retry-After header for
  // method/app limits; preserve that cooldown and drain buckets so all shared
  // callers pace themselves after the upstream limit resets.
  penalize(retryAfterMs = 1000) {
    const now = Date.now();
    const safeRetryAfterMs = Math.max(1000, Number(retryAfterMs) || 0);
    this.blockedUntil = Math.max(this.blockedUntil, now + safeRetryAfterMs);
    for (const bucket of this.buckets) {
      bucket.drain(now);
    }
  }

  // Wait until all buckets can consume the requested count.
  async acquire(count = 1) {
    while (true) {
      const now = Date.now();
      const canConsume = this.canConsume(count, now);
      if (canConsume) {
        this.consume(count);
        return;
      }

      
      const waitMs = Math.max(
        1,
        this.waitMsForCooldown,
        ...this.buckets.map((bucket) => bucket.waitMsForToken)
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

// === Riot-specific defaults ===
// Riot app/key limits allow 20 requests per second and 100 requests per 2 minutes.
// Enforce both windows so callers stay within the expected Riot limits by default.
export const RIOT_DEFAULT_PER_SECOND_LIMIT = 20;
export const RIOT_DEFAULT_PER_TWO_MINUTES_LIMIT = 100;

export function createRiotRateLimiter({
  perSecond = RIOT_DEFAULT_PER_SECOND_LIMIT,
  perTwoMinutes = RIOT_DEFAULT_PER_TWO_MINUTES_LIMIT,
} = {}) {
  console.log(`Creating Riot rate limiter with perSecond: ${perSecond}, perTwoMinutes: ${perTwoMinutes}`);
  const perSecondBucket = new TokenBucket({
    capacity: perSecond,
    refillPerMs: perSecond / 1000,
  });

  const perTwoMinutesBucket = new TokenBucket({
    capacity: perTwoMinutes,
    refillPerMs: perTwoMinutes / (120 * 1000),
  });

  return new CompositeRateLimiter([perSecondBucket, perTwoMinutesBucket]);
}
