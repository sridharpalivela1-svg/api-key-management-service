import { query } from '../db.js';

/**
 * Records an authenticated request into the audit_logs table
 */
export async function recordAuditLog(apiKeyId, endpoint, statusCode) {
  try {
    const sql = `
      INSERT INTO audit_logs (api_key_id, endpoint, status_code, timestamp)
      VALUES ($1, $2, $3, NOW())
      RETURNING id, timestamp;
    `;
    const res = await query(sql, [apiKeyId, endpoint, statusCode]);
    return res.rows[0];
  } catch (err) {
    console.error('[Audit Log] Failed to insert audit log entry:', err);
    // Non-blocking in production, but rethrown or logged so errors are visible
  }
}

/**
 * Fetches paginated audit logs for a tenant, joined with key metadata
 */
export async function getAuditLogsForTenant(tenantId, page = 1, limit = 20) {
  const offset = (page - 1) * limit;

  const countSql = `
    SELECT COUNT(*) as total
    FROM audit_logs a
    JOIN api_keys k ON a.api_key_id = k.id
    WHERE k.tenant_id = $1;
  `;
  const countRes = await query(countSql, [tenantId]);
  const total = parseInt(countRes.rows[0].total, 10);

  const logsSql = `
    SELECT 
      a.id,
      a.api_key_id,
      k.key_prefix,
      k.last_four,
      a.endpoint,
      a.status_code,
      a.timestamp
    FROM audit_logs a
    JOIN api_keys k ON a.api_key_id = k.id
    WHERE k.tenant_id = $1
    ORDER BY a.timestamp DESC
    LIMIT $2 OFFSET $3;
  `;

  const logsRes = await query(logsSql, [tenantId, limit, offset]);

  const items = logsRes.rows.map((row) => ({
    id: row.id,
    apiKeyId: row.api_key_id,
    maskedKey: `${row.key_prefix}...${row.last_four}`,
    endpoint: row.endpoint,
    statusCode: row.status_code,
    timestamp: row.timestamp.toISOString(),
  }));

  return {
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
    logs: items,
  };
}

/**
 * Fetches usage metrics grouped into intervals for Chart.js visualization
 */
export async function getTenantUsageStats(tenantId, hours = 1) {
  // Buckets requests by 1-minute intervals over the past N hours
  const sql = `
    SELECT 
      date_trunc('minute', a.timestamp) AS bucket,
      a.status_code,
      COUNT(*) AS count
    FROM audit_logs a
    JOIN api_keys k ON a.api_key_id = k.id
    WHERE k.tenant_id = $1
      AND a.timestamp >= NOW() - ($2 || ' hours')::INTERVAL
    GROUP BY bucket, a.status_code
    ORDER BY bucket ASC;
  `;

  const res = await query(sql, [tenantId, hours]);
  return res.rows;
}
