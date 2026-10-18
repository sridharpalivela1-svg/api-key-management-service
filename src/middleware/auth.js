import { hashKey } from '../services/keyService.js';
import { query } from '../db.js';

/**
 * Authentication Middleware for protected routes.
 * 
 * Verifies the incoming Bearer token against stored SHA-256 key hashes.
 * Ensures the key is active and not expired (accounting for rotation grace periods).
 */
export async function authenticateApiKey(req, res, next) {
  const authHeader = req.headers['authorization'];

  if (!authHeader) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing Authorization header. Expected Bearer <api_key>',
    });
  }

  // Validate Bearer format
  const parts = authHeader.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer' || !parts[1]) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Malformed Authorization header. Format: Bearer <api_key>',
    });
  }

  const rawKey = parts[1];
  const computedHash = hashKey(rawKey);

  try {
    const sql = `
      SELECT id, tenant_id, key_prefix, last_four, rate_limit_per_minute, is_active, expires_at, created_at
      FROM api_keys
      WHERE key_hash = $1
        AND is_active = TRUE
        AND (expires_at IS NULL OR expires_at > NOW());
    `;

    const result = await query(sql, [computedHash]);

    if (result.rowCount === 0) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid, inactive, or expired API key',
      });
    }

    const keyRecord = result.rows[0];
    req.apiKey = keyRecord;
    req.tenantId = keyRecord.tenant_id;

    next();
  } catch (err) {
    console.error('[Auth Middleware] Error verifying API key:', err);
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Authentication check failed',
    });
  }
}
