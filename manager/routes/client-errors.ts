/**
 * Client Error Reporting API
 * Receives frontend errors and logs them via ErrorLogger
 *
 * This allows client-side errors to be captured in the same
 * error logging system as backend errors, giving admins visibility
 * into frontend issues.
 */

import express, { Request, Response } from 'express';
import { errorLogger } from '../services/ErrorLogger';
import { verifyToken } from '../lib/auth/token';
import { log } from '../lib/logger';
import { errorDetails } from '../lib/errors';

const router = express.Router();

// Parse JSON bodies
router.use(express.json({ limit: '10kb' })); // Limit payload size

interface ClientErrorBody {
  level: 'error' | 'warn';
  message: string;
  action: string;
  context?: Record<string, unknown>;
  stack?: string;
  timestamp?: string;
}

/**
 * POST /api/client-errors
 * Log a client-side error
 *
 * Body: {
 *   level: 'error' | 'warn',
 *   message: string,
 *   action: string,
 *   context?: object,
 *   stack?: string,
 *   timestamp?: string
 * }
 */
router.post('/', async (req: Request, res: Response) => {
  const { level, message, action, context = {}, stack, timestamp } = req.body as ClientErrorBody;

  // Basic validation
  if (!message || !action) {
    return res.status(400).json({ error: 'message and action required' });
  }

  if (!['error', 'warn'].includes(level)) {
    return res.status(400).json({ error: 'level must be error or warn' });
  }

  // Extract user from token if present (don't require auth)
  let username = 'anonymous';
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      const payload = verifyToken(token);
      if (payload?.username && typeof payload.username === 'string') {
        username = payload.username;
      }
    } catch {
      // Invalid token - continue with anonymous user
    }
  }

  // Add client metadata to context
  const enrichedContext = {
    ...context,
    source: 'client',
    ip: req.ip || (req.connection as { remoteAddress?: string })?.remoteAddress,
    userAgent: req.headers['user-agent'],
    clientTimestamp: timestamp,
  };

  try {
    if (level === 'error') {
      await errorLogger.logError({
        user: username,
        action: `client:${action}`,
        error: stack ? Object.assign(new Error(message), { stack }) : message,
        context: enrichedContext,
      });
    } else {
      await errorLogger.logWarning({
        user: username,
        action: `client:${action}`,
        error: message,
        context: enrichedContext,
      });
    }

    log.debug('Client error logged', { level, action, user: username });
    res.json({ success: true });
  } catch (err) {
    log.error('Failed to log client error', errorDetails(err));
    res.status(500).json({ error: 'Failed to log error' });
  }
});

export default router;

// CommonJS compatibility for existing require() calls
module.exports = router;
