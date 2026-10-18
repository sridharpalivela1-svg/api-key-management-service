import crypto from 'crypto';
import { redis } from '../redis.js';
import { config } from '../config.js';

/**
 * Sliding Window Rate Limiter using Redis Sorted Sets
 * Implemented from first principles without external rate-limiting libraries.
 *
 * Algorithm:
 * 1. Calculate currentTime in ms and window cutoff (currentTime - windowMs).
 * 2. In a Redis MULTI/EXEC transaction:
 *    a. ZREMRANGEBYSCORE {key} 0 {cutoff}: Remove all timestamps outside the current window.
 *    b. ZADD {key} {currentTime} {currentTime:uniqueId}: Add current request timestamp.
 *    c. ZCARD {key}: Count total requests within the active sliding window.
 *    d. EXPIRE {key} {ttl}: Maintain key lifecycle to prevent memory leaks.
 * 3. Evaluate total count against key's rate_limit_per_minute.
 * 4. If count > limit, calculate Retry-After based on oldest timestamp in window.
 */
export async function checkRateLimit(apiKeyId, rateLimitPerMinute, windowSeconds = config.apiKey.rateLimitWindowSeconds) {
  const windowMs = windowSeconds * 1000;
  const now = Date.now();
  const clearBefore = now - windowMs;
  const redisKey = `rate_limit:${apiKeyId}`;
  
  // Member combines timestamp and high-entropy suffix to ensure distinct entries in sorted set
  const member = `${now}:${crypto.randomBytes(6).toString('hex')}`;

  // Execute Redis transaction atomically
  const multi = redis.multi();
  multi.zremrangebyscore(redisKey, 0, clearBefore);
  multi.zadd(redisKey, now, member);
  multi.zcard(redisKey);
  multi.expire(redisKey, windowSeconds * 2);

  const results = await multi.exec();

  if (!results) {
    throw new Error('Redis transaction failed during rate limit check');
  }

  // results[2] corresponds to ZCARD
  const [zcardErr, currentCount] = results[2];
  if (zcardErr) {
    throw zcardErr;
  }

  const limit = rateLimitPerMinute || config.apiKey.defaultRateLimitPerMinute;
  const allowed = currentCount <= limit;

  let retryAfter = 0;
  if (!allowed) {
    // Find oldest request timestamp in active window to compute exact Retry-After seconds
    const oldestEntries = await redis.zrange(redisKey, 0, 0, 'WITHSCORES');
    if (oldestEntries && oldestEntries.length >= 2) {
      const oldestTimestamp = parseFloat(oldestEntries[1]);
      const msUntilExpiry = (oldestTimestamp + windowMs) - now;
      retryAfter = Math.max(1, Math.ceil(msUntilExpiry / 1000));
    } else {
      retryAfter = windowSeconds;
    }
  }

  const remaining = Math.max(0, limit - currentCount);

  return {
    allowed,
    currentCount,
    limit,
    remaining,
    retryAfter,
    windowSeconds,
  };
}
