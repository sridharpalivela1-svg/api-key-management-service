import crypto from 'crypto';
import pkg from 'pg';
const { Pool } = pkg;

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_PORT = parseInt(process.env.DB_PORT || '5432', 10);
const DB_NAME = process.env.DB_NAME || 'apikeydb';
const DB_USER = process.env.DB_USER || 'postgres';
const DB_PASSWORD = process.env.DB_PASSWORD || 'postgres_secure_password';

const pool = new Pool({
  host: DB_HOST,
  port: DB_PORT,
  database: DB_NAME,
  user: DB_USER,
  password: DB_PASSWORD,
});

function hashKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) {
    failed++;
    console.error(`  ❌ FAILED: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  } else {
    passed++;
    console.log(`  ✅ PASSED: ${message}`);
  }
}

async function runTestSuite() {
  console.log('====================================================');
  console.log('   RUNNING API KEY MANAGEMENT SERVICE TEST SUITE    ');
  console.log('   Target: ' + BASE_URL);
  console.log('====================================================\n');

  try {
    // -----------------------------------------------------------------
    // TEST 1: Health Check & Service Availability
    // -----------------------------------------------------------------
    console.log('[Test 1] Health Check & Service Operational Verification');
    const healthRes = await fetch(`${BASE_URL}/health`);
    assert(healthRes.status === 200, 'GET /health returns 200 OK');
    const healthData = await healthRes.json();
    assert(healthData.status === 'healthy', 'Health status is "healthy"');
    assert(healthData.services.database === 'connected', 'Database is connected');
    assert(healthData.services.redis === 'connected', 'Redis is connected');

    // -----------------------------------------------------------------
    // TEST 2: Schema Verification (Core Requirement 2)
    // -----------------------------------------------------------------
    console.log('\n[Test 2] PostgreSQL Schema & Seeding Verification (Core Req 2)');
    const client = await pool.connect();
    try {
      // Check tables exist
      const tablesRes = await client.query(`
        SELECT table_name FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name IN ('tenants', 'api_keys', 'audit_logs');
      `);
      const tableNames = tablesRes.rows.map(r => r.table_name);
      assert(tableNames.includes('tenants'), 'tenants table exists');
      assert(tableNames.includes('api_keys'), 'api_keys table exists');
      assert(tableNames.includes('audit_logs'), 'audit_logs table exists');

      // Check tenants seed
      const tenantSeed = await client.query('SELECT id, name FROM tenants WHERE id = 1');
      assert(tenantSeed.rowCount >= 1, 'Initial seeded tenant exists (id: 1)');

      // Verify columns of api_keys
      const keyColsRes = await client.query(`
        SELECT column_name, is_nullable, data_type 
        FROM information_schema.columns 
        WHERE table_name = 'api_keys';
      `);
      const colMap = new Map(keyColsRes.rows.map(r => [r.column_name, r]));
      assert(colMap.has('id'), 'api_keys has id column');
      assert(colMap.has('tenant_id'), 'api_keys has tenant_id column');
      assert(colMap.has('key_hash'), 'api_keys has key_hash column');
      assert(colMap.has('last_four'), 'api_keys has last_four column');
      assert(colMap.has('rate_limit_per_minute'), 'api_keys has rate_limit_per_minute column');
      assert(colMap.has('is_active'), 'api_keys has is_active column');
      assert(colMap.has('expires_at'), 'api_keys has expires_at column');
    } finally {
      client.release();
    }

    // -----------------------------------------------------------------
    // TEST 3: Issue New API Key & Hashing (Core Requirement 3)
    // -----------------------------------------------------------------
    console.log('\n[Test 3] API Key Issuance & Secure Hashing (Core Req 3)');
    const issueRes = await fetch(`${BASE_URL}/api/tenants/1/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rateLimitPerMinute: 100 }),
    });

    assert(issueRes.status === 201, 'POST /api/tenants/1/keys returns 201 Created');
    const issueData = await issueRes.json();
    assert(typeof issueData.apiKey === 'string', 'Returned apiKey is a string');
    assert(issueData.apiKey.startsWith('sk_live_'), 'Key starts with standard prefix sk_live_');
    assert(typeof issueData.keyRecord === 'object', 'Returned payload contains keyRecord object');
    assert(typeof issueData.keyRecord.id === 'number', 'keyRecord.id is a number');
    assert(issueData.keyRecord.lastFour === issueData.apiKey.slice(-4), 'keyRecord.lastFour matches key suffix');
    assert(issueData.keyRecord.rateLimitPerMinute === 100, 'rateLimitPerMinute is 100');

    // Verify key_hash in DB equals SHA-256 and plaintext NOT stored
    const checkHashRes = await pool.query('SELECT key_hash FROM api_keys WHERE id = $1', [issueData.keyRecord.id]);
    assert(checkHashRes.rowCount === 1, 'Key record exists in api_keys table');
    const storedHash = checkHashRes.rows[0].key_hash;
    const expectedHash = hashKey(issueData.apiKey);
    assert(storedHash === expectedHash, 'key_hash in DB matches SHA-256 hash of plaintext key');
    assert(storedHash !== issueData.apiKey, 'Database does NOT store raw plaintext key');

    const createdKey1 = issueData.apiKey;
    const createdKeyId1 = issueData.keyRecord.id;

    // -----------------------------------------------------------------
    // TEST 4: List API Keys with Masking (Core Requirement 4)
    // -----------------------------------------------------------------
    console.log('\n[Test 4] List Keys with Key Masking (Core Req 4)');
    const listRes = await fetch(`${BASE_URL}/api/tenants/1/keys`);
    assert(listRes.status === 200, 'GET /api/tenants/1/keys returns 200 OK');
    const listData = await listRes.json();
    assert(Array.isArray(listData), 'Response is an array');
    const foundKey = listData.find(k => k.id === createdKeyId1);
    assert(!!foundKey, 'Newly created key is in the listed array');
    assert(typeof foundKey.maskedKey === 'string', 'maskedKey is a string');
    assert(foundKey.maskedKey.startsWith('sk_live_...'), 'maskedKey has prefix sk_live_...');
    assert(foundKey.maskedKey.endsWith(issueData.keyRecord.lastFour), 'maskedKey ends with last 4 characters');
    assert(foundKey.isActive === true, 'isActive is true');
    assert(typeof foundKey.createdAt === 'string', 'createdAt is a string timestamp');

    // -----------------------------------------------------------------
    // TEST 5: Authentication Middleware (Core Requirement 5)
    // -----------------------------------------------------------------
    console.log('\n[Test 5] Protected Endpoint Authentication (Core Req 5)');
    // 5a. Missing Authorization header
    const noAuthRes = await fetch(`${BASE_URL}/api/protected`);
    assert(noAuthRes.status === 401, 'Request without Authorization header returns 401 Unauthorized');

    // 5b. Malformed Authorization header
    const malformedRes = await fetch(`${BASE_URL}/api/protected`, {
      headers: { Authorization: 'Basic dXNlcjpwYXNz' },
    });
    assert(malformedRes.status === 401, 'Request with non-Bearer Authorization returns 401 Unauthorized');

    // 5c. Invalid key
    const invalidRes = await fetch(`${BASE_URL}/api/protected`, {
      headers: { Authorization: 'Bearer sk_live_invalid_key_value_12345' },
    });
    assert(invalidRes.status === 401, 'Request with invalid API key returns 401 Unauthorized');

    // 5d. Valid key
    const validRes = await fetch(`${BASE_URL}/api/protected`, {
      headers: { Authorization: `Bearer ${createdKey1}` },
    });
    assert(validRes.status === 200, 'Request with valid API key returns 200 OK');

    // -----------------------------------------------------------------
    // TEST 6: Sliding Window Rate Limiting (Core Requirement 6)
    // -----------------------------------------------------------------
    console.log('\n[Test 6] Sliding Window Rate Limiter (Core Req 6)');
    // Create key with rateLimitPerMinute: 5
    const limit5Res = await fetch(`${BASE_URL}/api/tenants/1/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rateLimitPerMinute: 5 }),
    });
    assert(limit5Res.status === 201, 'Created test key with rateLimitPerMinute = 5');
    const { apiKey: keyRateLimit5, keyRecord: keyRateLimit5Record } = await limit5Res.json();

    console.log('  -> Sending 5 requests in quick succession...');
    for (let i = 1; i <= 5; i++) {
      const r = await fetch(`${BASE_URL}/api/protected`, {
        headers: { Authorization: `Bearer ${keyRateLimit5}` },
      });
      assert(r.status === 200, `Request #${i} within quota returns 200 OK`);
    }

    console.log('  -> Sending 6th request (should exceed quota)...');
    const throttledRes = await fetch(`${BASE_URL}/api/protected`, {
      headers: { Authorization: `Bearer ${keyRateLimit5}` },
    });
    assert(throttledRes.status === 429, '6th request returns 429 Too Many Requests');
    const retryAfter = throttledRes.headers.get('Retry-After');
    assert(retryAfter !== null && !isNaN(parseInt(retryAfter, 10)), 'Retry-After header is present with numeric value: ' + retryAfter);
    assert(parseInt(retryAfter, 10) > 0, 'Retry-After is a positive number');

    // -----------------------------------------------------------------
    // TEST 7: Immediate Key Revocation (Core Requirement 7)
    // -----------------------------------------------------------------
    console.log('\n[Test 7] Key Revocation (Core Req 7)');
    // Issue key to revoke
    const revokeTestKeyRes = await fetch(`${BASE_URL}/api/tenants/1/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rateLimitPerMinute: 100 }),
    });
    const { apiKey: keyToRevoke, keyRecord: recToRevoke } = await revokeTestKeyRes.json();

    // Verify key works
    const preRevokeRes = await fetch(`${BASE_URL}/api/protected`, {
      headers: { Authorization: `Bearer ${keyToRevoke}` },
    });
    assert(preRevokeRes.status === 200, 'Pre-revocation request returns 200 OK');

    // Revoke key
    const deleteRes = await fetch(`${BASE_URL}/api/keys/${recToRevoke.id}`, {
      method: 'DELETE',
    });
    assert(deleteRes.status === 204, 'DELETE /api/keys/:keyId returns 204 No Content');

    // Verify key immediately rejected
    const postRevokeRes = await fetch(`${BASE_URL}/api/protected`, {
      headers: { Authorization: `Bearer ${keyToRevoke}` },
    });
    assert(postRevokeRes.status === 401, 'Post-revocation request immediately returns 401 Unauthorized');

    // -----------------------------------------------------------------
    // TEST 8: Key Rotation with Grace Period (Core Requirement 8)
    // -----------------------------------------------------------------
    console.log('\n[Test 8] Key Rotation & Grace Period (Core Req 8)');
    // Issue key_A
    const keyAIssue = await fetch(`${BASE_URL}/api/tenants/1/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rateLimitPerMinute: 100 }),
    });
    const { apiKey: key_A, keyRecord: rec_A } = await keyAIssue.json();

    // Rotate key_A to get key_B (1 minute grace period)
    const rotateRes = await fetch(`${BASE_URL}/api/keys/${rec_A.id}/rotate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gracePeriodSeconds: 2 }), // 2 seconds for automated testing!
    });
    assert(rotateRes.status === 200, 'POST /api/keys/:keyId/rotate returns 200 OK');
    const rotateData = await rotateRes.json();
    assert(typeof rotateData.newApiKey === 'string', 'Returned newApiKey string');
    const key_B = rotateData.newApiKey;
    assert(key_B !== key_A, 'newApiKey is different from old key');

    // Immediately test both keys
    const testA1 = await fetch(`${BASE_URL}/api/protected`, {
      headers: { Authorization: `Bearer ${key_A}` },
    });
    assert(testA1.status === 200, 'Immediately after rotation: old key (key_A) still succeeds (200 OK)');

    const testB1 = await fetch(`${BASE_URL}/api/protected`, {
      headers: { Authorization: `Bearer ${key_B}` },
    });
    assert(testB1.status === 200, 'Immediately after rotation: new key (key_B) succeeds (200 OK)');

    console.log('  -> Waiting 2.5 seconds for grace period to expire...');
    await sleep(2500);

    const testA2 = await fetch(`${BASE_URL}/api/protected`, {
      headers: { Authorization: `Bearer ${key_A}` },
    });
    assert(testA2.status === 401, 'After grace period expires: old key (key_A) returns 401 Unauthorized');

    const testB2 = await fetch(`${BASE_URL}/api/protected`, {
      headers: { Authorization: `Bearer ${key_B}` },
    });
    assert(testB2.status === 200, 'After grace period expires: new key (key_B) continues to succeed (200 OK)');

    // -----------------------------------------------------------------
    // TEST 9: Audit Logs Recording (Core Requirement 9)
    // -----------------------------------------------------------------
    console.log('\n[Test 9] Audit Log Recording (Core Req 9)');
    // Get initial audit log count
    const countRes1 = await pool.query('SELECT COUNT(*) as cnt FROM audit_logs');
    const initialCount = parseInt(countRes1.rows[0].cnt, 10);

    // Issue dedicated key for audit test
    const auditKeyRes = await fetch(`${BASE_URL}/api/tenants/1/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rateLimitPerMinute: 1 }), // limit = 1 to trigger both 200 and 429
    });
    const { apiKey: auditKey, keyRecord: auditRec } = await auditKeyRes.json();

    // 1st request -> 200 OK
    const auditReq1 = await fetch(`${BASE_URL}/api/protected`, {
      headers: { Authorization: `Bearer ${auditKey}` },
    });
    assert(auditReq1.status === 200, 'Audit test request #1 returns 200 OK');

    const countRes2 = await pool.query('SELECT COUNT(*) as cnt FROM audit_logs');
    const countAfter200 = parseInt(countRes2.rows[0].cnt, 10);
    assert(countAfter200 === initialCount + 1, 'Audit log count incremented by 1 after 200 OK');

    const latest200 = await pool.query(`
      SELECT api_key_id, endpoint, status_code FROM audit_logs WHERE api_key_id = $1 ORDER BY id DESC LIMIT 1
    `, [auditRec.id]);
    assert(latest200.rows[0].status_code === 200, 'Logged status_code is 200');
    assert(latest200.rows[0].endpoint === '/api/protected', 'Logged endpoint is /api/protected');
    assert(latest200.rows[0].api_key_id === auditRec.id, 'Logged api_key_id matches test key');

    // 2nd request -> 429 Too Many Requests
    const auditReq2 = await fetch(`${BASE_URL}/api/protected`, {
      headers: { Authorization: `Bearer ${auditKey}` },
    });
    assert(auditReq2.status === 429, 'Audit test request #2 returns 429 Too Many Requests');

    const countRes3 = await pool.query('SELECT COUNT(*) as cnt FROM audit_logs');
    const countAfter429 = parseInt(countRes3.rows[0].cnt, 10);
    assert(countAfter429 === countAfter200 + 1, 'Audit log count incremented by 1 after 429 Too Many Requests');

    const latest429 = await pool.query(`
      SELECT api_key_id, endpoint, status_code FROM audit_logs WHERE api_key_id = $1 ORDER BY id DESC LIMIT 1
    `, [auditRec.id]);
    assert(latest429.rows[0].status_code === 429, 'Logged status_code is 429');
    assert(latest429.rows[0].endpoint === '/api/protected', 'Logged endpoint is /api/protected');
    assert(latest429.rows[0].api_key_id === auditRec.id, 'Logged api_key_id matches test key');

    console.log('\n====================================================');
    console.log(`ALL TESTS COMPLETED SUCCESSFULLY! (${passed} PASSED, ${failed} FAILED)`);
    console.log('====================================================\n');
  } catch (err) {
    console.error('\nTest execution failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runTestSuite();
