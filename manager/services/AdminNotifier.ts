/**
 * AdminNotifier Service
 * Email notifications for admin error digest
 *
 * Note: Full email implementation requires SMTP configuration.
 * This service is designed to be ready for SMTP integration
 * but currently just logs what would be sent.
 */

import { log } from '../lib/logger';
import { errorLogger, ErrorEntry } from './ErrorLogger';

interface AdminNotifierConfig {
  adminEmail?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPass?: string;
  fromAddress?: string;
}

interface ErrorSummary {
  period: {
    since: string;
    until: string;
  };
  total: number;
  byLevel: Record<string, number>;
  byAction: Record<string, number>;
  recent: ErrorEntry[];
}

class AdminNotifier {
  private adminEmail: string | undefined;
  private smtpHost: string | undefined;
  private smtpPort: number;
  private smtpUser: string | undefined;
  private smtpPass: string | undefined;
  private fromAddress: string;
  private lastDigestTime: Date | null = null;

  constructor(config: AdminNotifierConfig = {}) {
    this.adminEmail = config.adminEmail || process.env.ADMIN_EMAIL;
    this.smtpHost = config.smtpHost || process.env.SMTP_HOST;
    this.smtpPort = config.smtpPort || parseInt(process.env.SMTP_PORT || '587', 10);
    this.smtpUser = config.smtpUser || process.env.SMTP_USER;
    this.smtpPass = config.smtpPass || process.env.SMTP_PASS;
    this.fromAddress = config.fromAddress || process.env.SMTP_FROM || 'rbiocverse@localhost';
  }

  /**
   * Check if email is configured
   */
  isConfigured(): boolean {
    return !!(this.adminEmail && this.smtpHost && this.smtpUser && this.smtpPass);
  }

  /**
   * Format error summary as plain text email
   */
  formatDigestEmail(summary: ErrorSummary): string {
    const lines = [
      'rbiocverse Error Digest',
      '========================',
      '',
      `Period: ${summary.period.since} to ${summary.period.until}`,
      `Total errors: ${summary.total}`,
      '',
    ];

    if (summary.total === 0) {
      lines.push('No errors in this period.');
      return lines.join('\n');
    }

    // Breakdown by level
    lines.push('By severity:');
    for (const [level, count] of Object.entries(summary.byLevel)) {
      lines.push(`  ${level}: ${count}`);
    }
    lines.push('');

    // Breakdown by action
    lines.push('By action:');
    for (const [action, count] of Object.entries(summary.byAction)) {
      lines.push(`  ${action}: ${count}`);
    }
    lines.push('');

    // Recent errors
    if (summary.recent.length > 0) {
      lines.push('Recent errors:');
      lines.push('--------------');
      for (const entry of summary.recent) {
        lines.push(`[${entry.timestamp}] ${entry.level.toUpperCase()}`);
        lines.push(`  User: ${entry.user}`);
        lines.push(`  Action: ${entry.action}`);
        lines.push(`  Message: ${entry.message}`);
        if (entry.code) {
          lines.push(`  Code: ${entry.code}`);
        }
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  /**
   * Send daily error digest
   * Should be called by a cron job or scheduled task
   */
  async sendDailyDigest(since: Date = new Date(Date.now() - 24 * 60 * 60 * 1000)): Promise<boolean> {
    const summary = await errorLogger.getSummary(since);

    // Don't send if no errors
    if (summary.total === 0) {
      log.info('No errors to report in daily digest');
      return true;
    }

    const subject = `rbiocverse Error Digest: ${summary.total} error(s)`;
    const body = this.formatDigestEmail(summary);

    return this.sendEmail(subject, body);
  }

  /**
   * Send an immediate alert for critical errors
   */
  async sendCriticalAlert(entry: ErrorEntry): Promise<boolean> {
    const subject = `[CRITICAL] rbiocverse: ${entry.action}`;
    const body = [
      'Critical Error Alert',
      '====================',
      '',
      `Time: ${entry.timestamp}`,
      `User: ${entry.user}`,
      `Action: ${entry.action}`,
      `Error: ${entry.message}`,
      entry.code ? `Code: ${entry.code}` : '',
      '',
      entry.context ? `Context: ${JSON.stringify(entry.context, null, 2)}` : '',
      '',
      entry.stack ? `Stack trace:\n${entry.stack}` : '',
    ].filter(Boolean).join('\n');

    return this.sendEmail(subject, body);
  }

  /**
   * Send an email
   */
  async sendEmail(subject: string, body: string): Promise<boolean> {
    if (!this.adminEmail) {
      log.warn('ADMIN_EMAIL not configured, skipping notification');
      return false;
    }

    if (!this.isConfigured()) {
      // Log what would be sent when SMTP is not configured
      log.info('Admin notification (SMTP not configured):', {
        to: this.adminEmail,
        subject,
        bodyLength: body.length,
      });
      log.debug('Email body would be:', body);
      return false;
    }

    // TODO(#64): Implement actual email sending with nodemailer
    // This is a placeholder for when SMTP is configured
    try {
      // const transporter = nodemailer.createTransport({
      //   host: this.smtpHost,
      //   port: this.smtpPort,
      //   secure: this.smtpPort === 465,
      //   auth: { user: this.smtpUser, pass: this.smtpPass },
      // });
      //
      // await transporter.sendMail({
      //   from: this.fromAddress,
      //   to: this.adminEmail,
      //   subject,
      //   text: body,
      // });

      log.info('Admin email sent (simulated):', { to: this.adminEmail, subject });
      this.lastDigestTime = new Date();
      return true;
    } catch (err) {
      log.error('Failed to send admin email:', { error: (err as Error).message });
      return false;
    }
  }
}

// Singleton instance
const adminNotifier = new AdminNotifier();

export { AdminNotifier, adminNotifier };

// CommonJS compatibility for existing require() calls
module.exports = { AdminNotifier, adminNotifier };
