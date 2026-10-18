import { checkRateLimit } from '../services/rateLimiterService.js';
import { recordAuditLog } from '../services/auditService.js';

/**
 * Sliding Window Rate Limiting Middleware
 * Enforces per-minute request quotas per API key using Redis sorted sets.
 */
export async function rateLimiterMiddleware(req, res, next) {
  if (!req.apiKey) {
    return res.status(500).json({ error: 'Internal Server Error', message: 'API key context missing' });
  }

  const apiKeyId = req.apiKey.id;
  const rateLimit = req.apiKey.rate_limit_per_minute;

  try {
    const result = await checkRateLimit(apiKeyId, rateLimit);

    res.setHeader('X-RateLimit-Limit', result.limit.toString());
    res.setHeader('X-RateLimit-Remaining', result.remaining.toString());

    if (!result.allowed) {
      // Set mandatory Retry-After header with seconds to wait
      res.setHeader('Retry-After', result.retryAfter.toString());

      // Requirement 9: Record 429 in audit_logs for authenticated requests
      const endpoint = req.originalUrl ? req.originalUrl.split('?')[0] : req.path;
      await recordAuditLog(apiKeyId, endpoint, 429);

      return res.status(429).json({
        error: 'Too Many Requests',
        message: `Rate limit of ${result.limit} requests per minute exceeded. Try again in ${result.retryAfter} seconds.`,
        retryAfter: result.retryAfter,
      });
    }

    req.rateLimit = result;
    next();
  } catch (err) {
    console.error('[RateLimiter Middleware] Error checking rate limit:', err);
    // If Redis has an issue, log and fail-open or return 500
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Rate limit verification encountered an unexpected error',
    });
  }
}
