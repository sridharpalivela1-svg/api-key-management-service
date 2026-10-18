import express from 'express';
import { authenticateApiKey } from '../middleware/auth.js';
import { rateLimiterMiddleware } from '../middleware/rateLimiter.js';
import { recordAuditLog } from '../services/auditService.js';

const router = express.Router();

/**
 * GET /api/protected
 * Core Requirements 5, 6, 9:
 * Authenticated & Rate-Limited protected route with automated audit logging.
 */
router.get(
  '/protected',
  authenticateApiKey,
  rateLimiterMiddleware,
  async (req, res) => {
    const endpoint = req.originalUrl ? req.originalUrl.split('?')[0] : '/api/protected';

    // Requirement 9: Record successful 200 in audit_logs
    await recordAuditLog(req.apiKey.id, endpoint, 200);

    return res.status(200).json({
      message: 'Access granted to protected resource',
      tenantId: req.tenantId,
      apiKeyId: req.apiKey.id,
      rateLimit: {
        limit: req.rateLimit.limit,
        remaining: req.rateLimit.remaining,
      },
      timestamp: new Date().toISOString(),
    });
  }
);

export default router;
