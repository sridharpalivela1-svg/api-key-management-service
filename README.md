# KeyShield: Secure Multi-Tenant API Key Management Service

KeyShield is a high-performance, multi-tenant API Key Management Gateway built from scratch. It features cryptographic key hashing, zero-downtime key rotation with grace periods, a custom sliding-window log rate limiter implemented directly with Redis sorted sets (without external rate-limiting libraries), and a real-time audit console.

---

## Architecture Overview

```
                      +-----------------------------+
                      |   Client Application / UI   |
                      +--------------+--------------+
                                     |
                                     |  HTTP (Bearer Token)
                                     v
                 +---------------------------------------+
                 |       KeyShield API Gateway (api)     |
                 |                                       |
                 |  - Authentication Middleware          |
                 |    (SHA-256 Hash Matching)            |
                 |  - Sliding-Window Rate Limiter        |
                 |    (Redis Sorted Sets MULTI/EXEC)     |
                 |  - Key Lifecycle Management           |
                 |    (Issuance, Masking, Rotation)      |
                 |  - Audit Console Static UI            |
                 +----------+-----------------+----------+
                            |                 |
         SQL Queries /      |                 |  Atomic Sorted Set
         Audit Logging      |                 |  Transactions (ZADD/ZCARD)
                            v                 v
                 +--------------------+     +-------------------+
                 | PostgreSQL DB (db) |     |  Redis Cache      |
                 |                    |     |  (redis)          |
                 | - tenants          |     |                   |
                 | - api_keys         |     | - rate_limit:{id} |
                 | - audit_logs       |     |   (Sorted Sets)   |
                 +--------------------+     +-------------------+
```

---

## Core Security & Architecture Principles

### 1. Cryptographic Key Hashing (SHA-256)
- **Generation**: API keys are generated using 32 cryptographically secure random bytes encoded with **Base64 URL-safe** encoding (RFC 4648 §5) and prepended with a standard prefix (`sk_live_`).
- **One-Way Storage**: Raw API keys are **never** stored in the database. Instead, only the SHA-256 hash is persisted alongside metadata (`key_prefix`, `last_four`, `rate_limit_per_minute`).
- **One-Time Exposure**: The plaintext key is returned to the client exactly once upon issuance or rotation.

### 2. Custom Sliding-Window Rate Limiter (Redis Sorted Sets)
Implemented from first principles using Redis sorted sets without relying on third-party libraries:
1. **Key Pattern**: `rate_limit:{apiKeyId}`.
2. **Atomic Execution**: An atomic Redis `MULTI/EXEC` transaction executes:
   - `ZREMRANGEBYSCORE rate_limit:{id} 0 {currentTime - windowMs}`: Prunes requests outside the rolling 60-second window.
   - `ZADD rate_limit:{id} {currentTime} {currentTime:uniqueId}`: Records the current request timestamp with a unique entropy suffix.
   - `ZCARD rate_limit:{id}`: Atomically measures the active request count in the window.
   - `EXPIRE rate_limit:{id} 120`: Sets TTL to automatically reclaim idle Redis memory.
3. **Throttling & Retry-After**: If the request count exceeds `rate_limit_per_minute`, the gateway rejects with `429 Too Many Requests`. The gateway inspects `ZRANGE ... WITHSCORES` for the earliest timestamp in the current window and computes the precise numeric `Retry-After` header in seconds.

### 3. Key Rotation with Grace Period
- When a key rotation is requested, KeyShield issues a new API key immediately.
- The previous key has its `expires_at` column set to 60 seconds into the future (grace period).
- During this window, both old and new keys authenticate seamlessly. Once the grace period expires, requests with the old key return `401 Unauthorized` without requiring asynchronous worker jobs.

### 4. Comprehensive Audit Logging
- Every authenticated request to `/api/protected`—both successful (`200 OK`) and rate-limited (`429 Too Many Requests`)—is inserted into the `audit_logs` table with `api_key_id`, `endpoint`, `status_code`, and `timestamp`.

---

## Database Schema Design

### `tenants`
| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `SERIAL` | `PRIMARY KEY` | Unique tenant ID |
| `name` | `VARCHAR(255)` | `NOT NULL` | Tenant or organization name |
| `created_at` | `TIMESTAMP` | `DEFAULT CURRENT_TIMESTAMP` | Account creation timestamp |

### `api_keys`
| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `SERIAL` | `PRIMARY KEY` | Key record ID |
| `tenant_id` | `INTEGER` | `NOT NULL, FK (tenants.id)` | Associated tenant |
| `key_hash` | `VARCHAR(255)` | `NOT NULL, UNIQUE` | SHA-256 hash of API key |
| `key_prefix` | `VARCHAR(10)` | `NOT NULL` | Non-secret prefix (`sk_live_`) |
| `last_four` | `VARCHAR(4)` | `NOT NULL` | Last 4 characters for masking |
| `rate_limit_per_minute` | `INTEGER` | `NOT NULL, DEFAULT 100` | Allowed requests / minute |
| `is_active` | `BOOLEAN` | `NOT NULL, DEFAULT TRUE` | Key validity status flag |
| `expires_at` | `TIMESTAMP` | `NULLABLE` | Expiration timestamp for rotation |
| `created_at` | `TIMESTAMP` | `DEFAULT CURRENT_TIMESTAMP` | Issuance timestamp |

### `audit_logs`
| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `SERIAL` | `PRIMARY KEY` | Log entry ID |
| `api_key_id` | `INTEGER` | `NOT NULL, FK (api_keys.id)` | API key used |
| `endpoint` | `VARCHAR(255)` | `NOT NULL` | Request URI path |
| `status_code` | `INTEGER` | `NOT NULL` | Final response code (`200` or `429`) |
| `timestamp` | `TIMESTAMP` | `DEFAULT CURRENT_TIMESTAMP` | Request timestamp |

---

## Quickstart with Docker Compose

### Prerequisites
- Docker & Docker Compose installed.

### 1. Launch Services
Run the following command at the root of the repository:
```bash
docker compose up --build
```

Docker Compose will start:
1. `db`: PostgreSQL container (health checked via `pg_isready`, auto-seeded with `scripts/init.sql`).
2. `redis`: Redis container (health checked via `redis-cli ping`).
3. `api`: Node.js API gateway (waits for `db` and `redis` to be healthy, health checked via `GET /health`).

### 2. Access the Console
Open your browser to:
```
http://localhost:3000
```
The console provides:
- Live API key listing with masked credentials (`sk_live_...4f2a`).
- Key generation with customizable rate limit quotas and one-time key reveal.
- Confirmation modals for Key Rotation and Immediate Revocation.
- Chart.js visualization of request traffic over the past hour.
- Interactive API sandbox to test single requests or burst requests (watching 429 and `Retry-After` in real time).
- Paginated immutable audit logs table.

---

## API Documentation

### 1. Issue New API Key
**POST** `/api/tenants/:tenantId/keys`
- **Request Body**:
  ```json
  {
    "rateLimitPerMinute": 100
  }
  ```
- **Response** (`201 Created`):
  ```json
  {
    "apiKey": "sk_live_vVbX6K_J7d1...w901",
    "keyRecord": {
      "id": 1,
      "lastFour": "w901",
      "rateLimitPerMinute": 100
    }
  }
  ```

### 2. List API Keys
**GET** `/api/tenants/:tenantId/keys`
- **Response** (`200 OK`):
  ```json
  [
    {
      "id": 1,
      "maskedKey": "sk_live_...w901",
      "createdAt": "2026-10-18T06:30:00.000Z",
      "isActive": true
    }
  ]
  ```

### 3. Access Protected Resource
**GET** `/api/protected`
- **Headers**:
  ```http
  Authorization: Bearer sk_live_vVbX6K_J7d1...w901
  ```
- **Response** (`200 OK`):
  ```json
  {
    "message": "Access granted to protected resource",
    "tenantId": 1,
    "apiKeyId": 1,
    "rateLimit": {
      "limit": 100,
      "remaining": 99
    },
    "timestamp": "2026-10-18T06:30:15.000Z"
  }
  ```
- **Rate Limited Response** (`429 Too Many Requests`):
  ```http
  HTTP/1.1 429 Too Many Requests
  Retry-After: 54
  Content-Type: application/json

  {
    "error": "Too Many Requests",
    "message": "Rate limit of 5 requests per minute exceeded. Try again in 54 seconds.",
    "retryAfter": 54
  }
  ```

### 4. Rotate API Key
**POST** `/api/keys/:keyId/rotate`
- **Request Body** *(Optional)*:
  ```json
  {
    "gracePeriodSeconds": 60
  }
  ```
- **Response** (`200 OK`):
  ```json
  {
    "newApiKey": "sk_live_nNw8L2_k9P2...m812"
  }
  ```

### 5. Revoke API Key
**DELETE** `/api/keys/:keyId`
- **Response** (`204 No Content`)

### 6. Audit Logs & Metrics
- **GET** `/api/tenants/:tenantId/audit-logs?page=1&limit=10`: Returns paginated audit trail.
- **GET** `/api/tenants/:tenantId/stats?hours=1`: Returns request volume buckets for Chart.js.
- **GET** `/health`: Service health check returning DB and Redis status.

---

## Running the Automated Test Suite

A comprehensive test suite is included in `scripts/test-suite.js` which verifies all 9 Core Requirements:
1. Docker compose service health checks
2. PostgreSQL tables schema inspection
3. API key issuance and SHA-256 hashing
4. Key listing with masked values
5. Protected endpoint authentication (valid, missing, malformed, invalid)
6. Sliding-window rate limiter with Redis sorted sets & `Retry-After` header
7. Immediate key revocation & subsequent 401
8. Key rotation with grace period transitions
9. Audit log persistence for 200 and 429 responses

To execute tests against the running instance:
```bash
npm test
```
Or execute within the Docker container:
```bash
docker compose exec api npm test
```

---

## License
MIT
