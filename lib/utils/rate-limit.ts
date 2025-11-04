import { LRUCache } from 'lru-cache';

type RateLimitOptions = { interval: number; uniqueTokenPerInterval: number };

export function rateLimit(options: RateLimitOptions) {
  const tokenCache = new LRUCache<string, number[]>({
    max: options.uniqueTokenPerInterval || 500,
    ttl: options.interval || 60000,
  });

  return {
    check: (limit: number, token: string) =>
      new Promise<void>((resolve, reject) => {
        const tokenCount = tokenCache.get(token) || [0];
        if (tokenCount[0] === 0) tokenCache.set(token, tokenCount);
        tokenCount[0] += 1;
        const isRateLimited = tokenCount[0] >= limit;
        return isRateLimited ? reject() : resolve();
      }),
  };
}

export const limiter = rateLimit({ interval: 60 * 1000, uniqueTokenPerInterval: 500 });
export const strictLimiter = rateLimit({ interval: 15 * 60 * 1000, uniqueTokenPerInterval: 500 });



