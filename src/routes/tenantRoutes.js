import express from 'express';
import { createKeyForTenant, getKeysForTenant } from '../services/keyService.js';
import { query } from '../db.js';

const router = express.Router();

/**
 * GET /api/tenants
 * Lists all registered tenants
 */
router.get('/tenants', async (req, res) => {
  try {
    const result = await query('SELECT id, name, created_at FROM tenants ORDER BY id ASC');
    res.json(result.rows);
  } catch (err) {
    console.error('[Tenant Routes] Error fetching tenants:', err);
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
  }
});

/**
 * POST /api/tenants
 * Creates a new tenant
 */
router.post('/tenants', async (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Bad Request', message: 'Tenant name is required' });
  }

  try {
    const result = await query(
      'INSERT INTO tenants (name) VALUES ($1) RETURNING id, name, created_at',
      [name.trim()]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[Tenant Routes] Error creating tenant:', err);
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
  }
});

/**
 * POST /api/tenants/:tenantId/keys
 * Core Requirement 3:
 * Issues a new API key for the given tenant. Hashed with SHA-256 before storage.
 */
router.post('/tenants/:tenantId/keys', async (req, res) => {
  const tenantId = parseInt(req.params.tenantId, 10);
  if (isNaN(tenantId)) {
    return res.status(400).json({ error: 'Bad Request', message: 'Invalid tenantId parameter' });
  }

  const { rateLimitPerMinute } = req.body || {};
  const parsedLimit = rateLimitPerMinute !== undefined ? parseInt(rateLimitPerMinute, 10) : undefined;

  try {
    const keyData = await createKeyForTenant(tenantId, parsedLimit);

    // Matches Core Requirement 3 Contract Specification:
    return res.status(201).json({
      apiKey: keyData.apiKey,
      keyRecord: {
        id: keyData.keyRecord.id,
        lastFour: keyData.keyRecord.lastFour,
        rateLimitPerMinute: keyData.keyRecord.rateLimitPerMinute,
      },
    });
  } catch (err) {
    if (err.status === 404) {
      return res.status(404).json({ error: 'Not Found', message: err.message });
    }
    console.error('[Tenant Routes] Error issuing key:', err);
    return res.status(500).json({ error: 'Internal Server Error', message: err.message });
  }
});

/**
 * GET /api/tenants/:tenantId/keys
 * Core Requirement 4:
 * Lists all API keys for a tenant with keys masked.
 */
router.get('/tenants/:tenantId/keys', async (req, res) => {
  const tenantId = parseInt(req.params.tenantId, 10);
  if (isNaN(tenantId)) {
    return res.status(400).json({ error: 'Bad Request', message: 'Invalid tenantId parameter' });
  }

  try {
    const keys = await getKeysForTenant(tenantId);

    // Core Requirement 4 Contract Specification:
    // [ { "id": "number", "maskedKey": "string", "createdAt": "string", "isActive": true } ]
    const responsePayload = keys.map((k) => ({
      id: k.id,
      maskedKey: k.maskedKey,
      createdAt: k.createdAt,
      isActive: k.isActive,
      // Metadata fields for console UI
      rateLimitPerMinute: k.rateLimitPerMinute,
      expiresAt: k.expiresAt,
    }));

    return res.status(200).json(responsePayload);
  } catch (err) {
    console.error('[Tenant Routes] Error listing keys:', err);
    return res.status(500).json({ error: 'Internal Server Error', message: err.message });
  }
});

export default router;
