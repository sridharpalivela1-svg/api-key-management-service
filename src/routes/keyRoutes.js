import express from 'express';
import { revokeKey, rotateKey } from '../services/keyService.js';
import { config } from '../config.js';

const router = express.Router();

/**
 * DELETE /api/keys/:keyId
 * Core Requirement 7:
 * Immediately revokes an API key (sets is_active = FALSE). Returns 204 No Content.
 */
router.delete('/keys/:keyId', async (req, res) => {
  const keyId = parseInt(req.params.keyId, 10);
  if (isNaN(keyId)) {
    return res.status(400).json({ error: 'Bad Request', message: 'Invalid keyId parameter' });
  }

  try {
    await revokeKey(keyId);
    // Contract Specification: 204 No Content
    return res.status(204).send();
  } catch (err) {
    if (err.status === 404) {
      return res.status(404).json({ error: 'Not Found', message: err.message });
    }
    console.error('[Key Routes] Error revoking key:', err);
    return res.status(500).json({ error: 'Internal Server Error', message: err.message });
  }
});

/**
 * POST /api/keys/:keyId/rotate
 * Core Requirement 8:
 * Rotates an API key with a 1-minute grace period. Returns 200 OK with newApiKey.
 */
router.post('/keys/:keyId/rotate', async (req, res) => {
  const keyId = parseInt(req.params.keyId, 10);
  if (isNaN(keyId)) {
    return res.status(400).json({ error: 'Bad Request', message: 'Invalid keyId parameter' });
  }

  // Grace period default is 60 seconds (1 minute) as specified in Requirement 8
  const gracePeriodSeconds = req.body && req.body.gracePeriodSeconds
    ? parseInt(req.body.gracePeriodSeconds, 10)
    : config.apiKey.rotationGracePeriodSeconds;

  try {
    const result = await rotateKey(keyId, gracePeriodSeconds);

    // Contract Specification: { "newApiKey": "string" }
    return res.status(200).json({
      newApiKey: result.newApiKey,
      newKeyRecord: result.newKeyRecord, // extra helper for frontend
    });
  } catch (err) {
    if (err.status === 404) {
      return res.status(404).json({ error: 'Not Found', message: err.message });
    }
    if (err.status === 400) {
      return res.status(400).json({ error: 'Bad Request', message: err.message });
    }
    console.error('[Key Routes] Error rotating key:', err);
    return res.status(500).json({ error: 'Internal Server Error', message: err.message });
  }
});

export default router;
