/**
 * AdminNotifier Service
 * Email notifications for admin error digest.
 *
 * Enable by setting SMTP_HOST (and ADMIN_EMAIL). SMTP_USER/SMTP_PASS are
 * optional — omit for unauthenticated relay (e.g. localhost postfix).
 * When SMTP_HOST is not set, notifications are logged only.
 */

import nodemailer, { Transporter } from 'nodemailer';
import { log } from '../lib/logger';
import { errorDetails } from '../lib/errors';
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
  private transporter: Transporter | null = null;

  constructor(config: AdminNotifierConfig = {}) {
    this.adminEmail = config.adminEmail || process.env.ADMIN_EMAIL;
    this.smtpHost = config.smtpHost || process.env.SMTP_HOST;
    this.smtpPort = config.smtpPort || parseInt(process.env.SMTP_PORT || '587', 10);
    this.smtpUser = config.smtpUser || process.env.SMTP_USER;
    this.smtpPass = config.smtpPass || process.env.SMTP_PASS;
    this.fromAddress = config.fromAddress || process.env.SMTP_FROM || 'rbiocverse@localhost';

    if (this.isConfigured()) {
      this.transporter = this.createTransporter();
    }
  }

  /**
   * Check if email is configured.
   * Only SMTP_HOST and ADMIN_EMAIL are required; auth is optional (supports unauthenticated relay).
   */
  isConfigured(): boolean {
    return !!(this.adminEmail && this.smtpHost);
  }

  /**
   * Build a nodemailer transporter.
   * Uses auth when SMTP_USER is set; plain relay otherwise (e.g. localhost:25).
   */
  private createTransporter(): Transporter {
    const options = {
      host: this.smtpHost!,
      port: this.smtpPort,
      secure: this.smtpPort === 465,
      auth: this.smtpUser
        ? { user: this.smtpUser, pass: this.smtpPass || '' }
        : undefined,
    };
    return nodemailer.createTransport(options);
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
   */
  async sendDailyDigest(since: Date = new Date(Date.now() - 24 * 60 * 60 * 1000)): Promise<boolean> {
    const summary = await errorLogger.getSummary(since);

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
   * Send an email. Falls back to log-only when SMTP_HOST is not configured.
   */
  async sendEmail(subject: string, body: string): Promise<boolean> {
    if (!this.adminEmail) {
      log.warn('ADMIN_EMAIL not configured, skipping notification');
      return false;
    }

    if (!this.isConfigured() || !this.transporter) {
      log.info('Admin notification (SMTP not configured, set SMTP_HOST to enable)', {
        to: this.adminEmail,
        subject,
        bodyLength: body.length,
      });
      return false;
    }

    try {
      await this.transporter.sendMail({
        from: this.fromAddress,
        to: this.adminEmail,
        subject,
        text: body,
      });
      log.info('Admin email sent', { to: this.adminEmail, subject });
      return true;
    } catch (err) {
      log.error('Failed to send admin email', { to: this.adminEmail, subject, ...errorDetails(err) });
      return false;
    }
  }
}

// Singleton instance
const adminNotifier = new AdminNotifier();

export { AdminNotifier, adminNotifier };

// CommonJS compatibility for existing require() calls
module.exports = { AdminNotifier, adminNotifier };
