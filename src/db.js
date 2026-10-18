import pkg from 'pg';
const { Pool } = pkg;
import { config } from './config.js';

export const pool = new Pool(config.db);

pool.on('error', (err) => {
  console.error('[DB] Unexpected error on idle PostgreSQL client:', err);
});

export const query = (text, params) => pool.query(text, params);

/**
 * Ensures schema tables and initial seed data exist
 */
export async function initDb() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Tenants table
    await client.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // API Keys table
    await client.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        key_hash VARCHAR(255) NOT NULL UNIQUE,
        key_prefix VARCHAR(10) NOT NULL DEFAULT 'sk_live_',
        last_four VARCHAR(4) NOT NULL,
        rate_limit_per_minute INTEGER NOT NULL DEFAULT 100,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        expires_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Audit logs table
    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        api_key_id INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
        endpoint VARCHAR(255) NOT NULL,
        status_code INTEGER NOT NULL,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Indexes
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys(key_hash);
      CREATE INDEX IF NOT EXISTS idx_api_keys_tenant_id ON api_keys(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_api_keys_lookup ON api_keys(key_hash, is_active, expires_at);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_api_key_id ON audit_logs(api_key_id);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp DESC);
    `);

    // Seed default tenant if table is empty
    const checkTenant = await client.query('SELECT id FROM tenants LIMIT 1');
    if (checkTenant.rowCount === 0) {
      await client.query(`
        INSERT INTO tenants (id, name) VALUES (1, 'Acme Corporation')
        ON CONFLICT (id) DO NOTHING;
      `);
      await client.query(`
        SELECT setval('tenants_id_seq', (SELECT COALESCE(MAX(id), 1) FROM tenants));
      `);
      console.log('[DB] Seeded initial tenant (id: 1, name: Acme Corporation)');
    }

    await client.query('COMMIT');
    console.log('[DB] PostgreSQL schema initialized successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[DB] Error initializing schema:', err);
    throw err;
  } finally {
    client.release();
  }
}
