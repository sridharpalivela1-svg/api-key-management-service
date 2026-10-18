import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { query } from './db.js';
import { pingRedis } from './redis.js';

import tenantRoutes from './routes/tenantRoutes.js';
import keyRoutes from './routes/keyRoutes.js';
import protectedRoutes from './routes/protectedRoutes.js';
import auditRoutes from './routes/auditRoutes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const app = express();

// Middlewares
app.use(cors());
app.use(express.json());

// Serve Frontend Console static assets
app.use(express.static(path.join(__dirname, '../public')));

// Health Check Endpoint (used by Docker Compose and monitor probes)
app.get('/health', async (req, res) => {
  try {
    // 1. Verify DB connection
    await query('SELECT 1');
    // 2. Verify Redis connection
    await pingRedis();

    return res.status(200).json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      services: {
        database: 'connected',
        redis: 'connected',
      },
    });
  } catch (err) {
    return res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: err.message,
    });
  }
});

// API Routes
app.use('/api', tenantRoutes);
app.use('/api', keyRoutes);
app.use('/api', protectedRoutes);
app.use('/api', auditRoutes);

// Catch-all for API 404s
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: 'Not Found', message: `Route ${req.originalUrl} not found` });
});

// Central Error Handler
app.use((err, req, res, next) => {
  console.error('[App Error Handler]', err);
  const status = err.status || 500;
  res.status(status).json({
    error: err.name || 'Internal Server Error',
    message: err.message || 'An unexpected error occurred',
  });
});
