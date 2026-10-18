import crypto from 'crypto';
import { query, pool } from '../db.js';
import { config } from '../config.js';

/**
 * Generates a secure random API key, its SHA-256 hash, and metadata
 */
export function generateApiKey(prefix = config.apiKey.prefix) {
  // Generate 32 cryptographically secure random bytes
  const randomBytes = crypto.randomBytes(32).toString('base64url');
  const fullKey = `${prefix}${randomBytes}`;
  const lastFour = fullKey.slice(-4);
  const keyHash = hashKey(fullKey);

  return {
    fullKey,
    keyHash,
    keyPrefix: prefix,
    lastFour,
  };
}

/**
 * Computes SHA-256 cryptographic hash of a raw key string
 */
export function hashKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

/**
 * Issues a new API key for a given tenant
 */
export async function createKeyForTenant(tenantId, rateLimitPerMinute) {
  // Verify tenant exists
  const tenantRes = await query('SELECT id FROM tenants WHERE id = $1', [tenantId]);
  if (tenantRes.rowCount === 0) {
    const error = new Error(`Tenant with ID ${tenantId} not found`);
    error.status = 404;
    throw error;
  }

  const limit = Number.isInteger(rateLimitPerMinute) && rateLimitPerMinute > 0
    ? rateLimitPerMinute
    : config.apiKey.defaultRateLimitPerMinute;

  const keyData = generateApiKey(config.apiKey.prefix);

  const insertSql = `
    INSERT INTO api_keys (
      tenant_id,
      key_hash,
      key_prefix,
      last_four,
      rate_limit_per_minute,
      is_active,
      expires_at
    )
    VALUES ($1, $2, $3, $4, $5, TRUE, NULL)
    RETURNING id, last_four, rate_limit_per_minute, created_at, is_active;
  `;

  const result = await query(insertSql, [
    tenantId,
    keyData.keyHash,
    keyData.keyPrefix,
    keyData.lastFour,
    limit,
  ]);

  const row = result.rows[0];

  return {
    apiKey: keyData.fullKey,
    keyRecord: {
      id: row.id,
      lastFour: row.last_four,
      rateLimitPerMinute: row.rate_limit_per_minute,
      createdAt: row.created_at,
      isActive: row.is_active,
    },
  };
}

/**
 * Retrieves all API keys for a tenant with keys masked
 */
export async function getKeysForTenant(tenantId) {
  const sql = `
    SELECT id, key_prefix, last_four, rate_limit_per_minute, is_active, expires_at, created_at
    FROM api_keys
    WHERE tenant_id = $1
    ORDER BY created_at DESC;
  `;

  const result = await query(sql, [tenantId]);

  return result.rows.map((row) => ({
    id: row.id,
    maskedKey: `${row.key_prefix}...${row.last_four}`,
    createdAt: row.created_at.toISOString(),
    isActive: row.is_active && (!row.expires_at || new Date(row.expires_at) > new Date()),
    // Additional helpful metadata for frontend console
    rawIsActive: row.is_active,
    rateLimitPerMinute: row.rate_limit_per_minute,
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
  }));
}

/**
 * Revokes an API key immediately by setting is_active = FALSE
 */
export async function revokeKey(keyId) {
  const sql = `
    UPDATE api_keys
    SET is_active = FALSE
    WHERE id = $1
    RETURNING id;
  `;

  const result = await query(sql, [keyId]);
  if (result.rowCount === 0) {
    const error = new Error(`API key with ID ${keyId} not found`);
    error.status = 404;
    throw error;
  }

  return true;
}

/**
 * Rotates an API key: generates a new key and sets the old key's expiration to gracePeriodSeconds
 */
export async function rotateKey(keyId, gracePeriodSeconds = config.apiKey.rotationGracePeriodSeconds) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Fetch old key record
    const fetchSql = `
      SELECT id, tenant_id, key_prefix, rate_limit_per_minute, is_active, expires_at
      FROM api_keys
      WHERE id = $1
      FOR UPDATE;
    `;
    const oldKeyRes = await client.query(fetchSql, [keyId]);

    if (oldKeyRes.rowCount === 0) {
      const error = new Error(`API key with ID ${keyId} not found`);
      error.status = 404;
      throw error;
    }

    const oldKey = oldKeyRes.rows[0];

    if (!oldKey.is_active) {
      const error = new Error(`Cannot rotate revoked API key`);
      error.status = 400;
      throw error;
    }

    // 2. Generate new key with the same prefix and rate limit
    const newKeyData = generateApiKey(oldKey.key_prefix);

    // 3. Insert new key for the same tenant
    const insertSql = `
      INSERT INTO api_keys (
        tenant_id,
        key_hash,
        key_prefix,
        last_four,
        rate_limit_per_minute,
        is_active,
        expires_at
      )
      VALUES ($1, $2, $3, $4, $5, TRUE, NULL)
      RETURNING id, last_four, rate_limit_per_minute, created_at;
    `;
    const insertRes = await client.query(insertSql, [
      oldKey.tenant_id,
      newKeyData.keyHash,
      newKeyData.keyPrefix,
      newKeyData.lastFour,
      oldKey.rate_limit_per_minute,
    ]);

    // 4. Update old key's expires_at to grace period in the future
    const updateOldSql = `
      UPDATE api_keys
      SET expires_at = NOW() + ($1 || ' seconds')::INTERVAL
      WHERE id = $2;
    `;
    await client.query(updateOldSql, [gracePeriodSeconds, keyId]);

    await client.query('COMMIT');

    return {
      newApiKey: newKeyData.fullKey,
      newKeyRecord: {
        id: insertRes.rows[0].id,
        lastFour: insertRes.rows[0].last_four,
        rateLimitPerMinute: insertRes.rows[0].rate_limit_per_minute,
      },
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
