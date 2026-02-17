/**
 * JWT-like Token Generation and Verification
 * Simple token handling without external dependencies
 */

import crypto from 'crypto';
import { config } from '../../config';

interface TokenPayload {
  iat: number;
  exp: number;
  [key: string]: unknown;
}

/**
 * Generate a simple token
 * Format: base64(payload).base64(signature)
 */
function generateToken(
  payload: Record<string, unknown>,
  expiresIn: number = config.sessionExpiryDays * 24 * 60 * 60
): string {
  const data: TokenPayload = {
    ...payload,
    iat: Date.now(),
    exp: Date.now() + expiresIn * 1000,
  };
  const payloadStr = Buffer.from(JSON.stringify(data)).toString('base64url');
  // jwtSecret is validated at startup in config/index.ts - app won't run without it
  const signature = crypto
    .createHmac('sha256', config.jwtSecret!)
    .update(payloadStr)
    .digest('base64url');
  return `${payloadStr}.${signature}`;
}

/**
 * Verify and decode a token
 */
function verifyToken(token: string | undefined | null): TokenPayload | null {
  if (!token) return null;

  const [payloadStr, signature] = token.split('.');
  if (!payloadStr || !signature) return null;

  // Verify signature using constant-time comparison to prevent timing attacks
  // jwtSecret is validated at startup in config/index.ts - app won't run without it
  const expectedSig = crypto
    .createHmac('sha256', config.jwtSecret!)
    .update(payloadStr)
    .digest('base64url');

  // Use timingSafeEqual for cryptographic comparison
  const expectedSigBuffer = Buffer.from(expectedSig, 'utf8');
  const signatureBuffer = Buffer.from(signature, 'utf8');

  if (expectedSigBuffer.length !== signatureBuffer.length ||
      !crypto.timingSafeEqual(expectedSigBuffer, signatureBuffer)) {
    return null;
  }

  // Decode and check expiry
  try {
    const payload = JSON.parse(Buffer.from(payloadStr, 'base64url').toString()) as TokenPayload;
    if (payload.exp && payload.exp < Date.now()) {
      return null; // Expired
    }
    return payload;
  } catch {
    return null;
  }
}

export type { TokenPayload };

export {
  generateToken,
  verifyToken,
};

// CommonJS compatibility for existing require() calls
module.exports = {
  generateToken,
  verifyToken,
};
