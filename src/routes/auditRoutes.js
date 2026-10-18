import express from 'express';
import { getAuditLogsForTenant, getTenantUsageStats } from '../services/auditService.js';
import { query } from '../db.js';

const router = express.Router();

/**
 * GET /api/tenants/:tenantId/audit-logs
 * Fetches paginated audit logs for a tenant
 */
router.get('/tenants/:tenantId/audit-logs', async (req, res) => {
  const tenantId = parseInt(req.params.tenantId, 10);
  if (isNaN(tenantId)) {
    return res.status(400).json({ error: 'Bad Request', message: 'Invalid tenantId' });
  }

  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '10', 10)));

  try {
    const data = await getAuditLogsForTenant(tenantId, page, limit);
    res.json(data);
  } catch (err) {
    console.error('[Audit Routes] Error fetching tenant audit logs:', err);
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
  }
});

/**
 * GET /api/tenants/:tenantId/stats
 * Fetches usage metrics for visualization (e.g. Chart.js)
 */
router.get('/tenants/:tenantId/stats', async (req, res) => {
  const tenantId = parseInt(req.params.tenantId, 10);
  if (isNaN(tenantId)) {
    return res.status(400).json({ error: 'Bad Request', message: 'Invalid tenantId' });
  }

  const hours = parseFloat(req.query.hours || '1');

  try {
    const stats = await getTenantUsageStats(tenantId, hours);
    res.json({ tenantId, hours, stats });
  } catch (err) {
    console.error('[Audit Routes] Error fetching usage stats:', err);
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
  }
});

/**
 * GET /api/audit-logs
 * Global audit logs inspection
 */
router.get('/audit-logs', async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '50', 10)));
    const sql = `
      SELECT a.id, a.api_key_id, k.key_prefix, k.last_four, a.endpoint, a.status_code, a.timestamp
      FROM audit_logs a
      LEFT JOIN api_keys k ON a.api_key_id = k.id
      ORDER BY a.timestamp DESC
      LIMIT $1;
    `;
    const result = await query(sql, [limit]);
    res.json(result.rows);
  } catch (err) {
    console.error('[Audit Routes] Error fetching global audit logs:', err);
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
  }
});

export default router;
