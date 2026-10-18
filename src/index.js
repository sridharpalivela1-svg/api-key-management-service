import { app } from './app.js';
import { config } from './config.js';
import { initDb, pool } from './db.js';
import { redis, pingRedis } from './redis.js';

async function startServer() {
  console.log('--- Starting API Key Management Service ---');

  // Verify and initialize Database
  try {
    await initDb();
    console.log('[Startup] Database connection established and verified.');
  } catch (err) {
    console.error('[Startup] Failed to initialize database:', err);
    process.exit(1);
  }

  // Verify Redis
  try {
    await pingRedis();
    console.log('[Startup] Redis connection established and verified.');
  } catch (err) {
    console.error('[Startup] Failed to connect to Redis:', err);
    process.exit(1);
  }

  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`[Startup] API Gateway & Console listening on http://0.0.0.0:${config.port}`);
  });

  // Graceful shutdown handling
  const shutdown = async (signal) => {
    console.log(`\n[Shutdown] Received ${signal}. Closing gracefully...`);
    server.close(async () => {
      console.log('[Shutdown] HTTP server closed.');
      try {
        await pool.end();
        console.log('[Shutdown] Database pool closed.');
        await redis.quit();
        console.log('[Shutdown] Redis connection closed.');
      } catch (err) {
        console.error('[Shutdown] Error during shutdown:', err);
      }
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

startServer();
