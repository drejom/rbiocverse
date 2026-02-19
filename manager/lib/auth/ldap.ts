/**
 * LDAP/AD Authentication
 *
 * Feature flag: presence of LDAP_URL enables LDAP mode.
 * Omit LDAP_URL to use TEST_USERNAME/TEST_PASSWORD (dev mode).
 */

import crypto from 'crypto';
import { Client, InvalidCredentialsError } from 'ldapts';
import { log } from '../logger';

export interface AuthResult {
  success: boolean;
  fullName?: string; // only present when success: true
}

/** Convert 'coh.org' → 'DC=coh,DC=org' */
function domainToBaseDn(domain: string): string {
  return domain.split('.').map(part => `DC=${part}`).join(',');
}

export async function authenticate(username: string, password: string): Promise<AuthResult> {
  const ldapUrlEnv = process.env.LDAP_URL;
  const ldapDomain = process.env.LDAP_DOMAIN;

  // Dev/test mode: LDAP_URL unset → compare against TEST_* env vars only
  if (!ldapUrlEnv) {
    const testUser = process.env.TEST_USERNAME;
    const testPass = process.env.TEST_PASSWORD;

    if (!testUser || !testPass) {
      throw new Error('Authentication not configured: set LDAP_URL or TEST_USERNAME/TEST_PASSWORD');
    }

    const uBuf = Buffer.from(username);
    const pBuf = Buffer.from(password);
    const tuBuf = Buffer.from(testUser);
    const tpBuf = Buffer.from(testPass);

    const usernameValid = uBuf.length === tuBuf.length &&
      crypto.timingSafeEqual(uBuf, tuBuf);
    const passwordValid = pBuf.length === tpBuf.length &&
      crypto.timingSafeEqual(pBuf, tpBuf);

    if (!usernameValid || !passwordValid) return { success: false };

    return { success: true, fullName: process.env.TEST_FULLNAME || username };
  }

  if (!ldapDomain) {
    throw new Error('LDAP authentication enabled but LDAP_DOMAIN is not configured');
  }

  // Production mode: try each DC in sequence (comma-separated LDAP_URL)
  const ldapUrls = ldapUrlEnv.split(',').map(u => u.trim()).filter(Boolean);
  const baseDn = domainToBaseDn(ldapDomain);
  const upn = `${username}@${ldapDomain}`;

  for (const url of ldapUrls) {
    const client = new Client({ url, connectTimeout: 5000, timeout: 5000 });
    try {
      await client.bind(upn, password);

      // Bind succeeded — search for displayName using user's own credentials
      const { searchEntries } = await client.search(baseDn, {
        scope: 'sub',
        filter: `(userPrincipalName=${upn})`,
        attributes: ['displayName', 'cn'],
      });

      const entry = searchEntries[0];
      const displayName = Array.isArray(entry?.displayName) ? entry.displayName[0] : entry?.displayName;
      const cn = Array.isArray(entry?.cn) ? entry.cn[0] : entry?.cn;
      const fullName = (displayName as string) || (cn as string) || username;

      log.debug('LDAP auth success', { username, fullName, dc: url });
      return { success: true, fullName };

    } catch (err) {
      if (err instanceof InvalidCredentialsError) {
        // Wrong password — same answer from all DCs, no point trying others
        return { success: false };
      }
      // DC unreachable — try next
      log.warn('LDAP DC unreachable, trying next', {
        url,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      await client.unbind().catch(() => {});
    }
  }

  // All DCs failed
  throw new Error(`All LDAP domain controllers unreachable (tried: ${ldapUrls.join(', ')})`);
}
