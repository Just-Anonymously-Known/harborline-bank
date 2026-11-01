const nodemailer = require('nodemailer');

const mailer = process.env.SMTP_HOST ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_SECURE === 'true',
  auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined
}) : null;

async function sendMail({ to, subject, text, html }) {
  if (!mailer) {
    if (process.env.NODE_ENV === 'production') throw new Error('Email delivery is not configured.');
    console.log(`[LOCAL MAIL] to=${to} subject=${subject}\n${text}`);
    return { localOnly: true, accepted: [to], rejected: [] };
  }
  if (!process.env.SMTP_USER || !process.env.SMTP_PASSWORD || !process.env.MAIL_FROM) {
    const error = new Error('Email settings are incomplete. Add SMTP_USER, SMTP_PASSWORD, and MAIL_FROM.');
    error.status = 503; error.code = 'EMAIL_DELIVERY'; throw error;
  }
  try {
    return await mailer.sendMail({ from: process.env.MAIL_FROM, to, subject, text, html });
  } catch (cause) {
    console.error('SMTP send failed:', {
      code: cause.code, responseCode: cause.responseCode,
      command: cause.command, syscall: cause.syscall,
      address: cause.address, port: cause.port
    });
    const message = cause.code === 'EAUTH'
      ? 'SMTP authentication failed. Check SMTP_USER and the Google App Password.'
      : ['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS'].includes(cause.code)
        ? 'Could not connect to the SMTP server. Check SMTP_HOST, SMTP_PORT, and SMTP_SECURE.'
        : 'The SMTP server rejected the email. Check the sender address and mail settings.';
    const error = new Error(message); error.status = 503; error.code = 'EMAIL_DELIVERY'; throw error;
  }
}

async function checkMailer() {
  if (!mailer) return { ready: false, reason: 'SMTP_HOST is missing.' };
  if (!process.env.SMTP_USER || !process.env.SMTP_PASSWORD || !process.env.MAIL_FROM) return { ready: false, reason: 'SMTP_USER, SMTP_PASSWORD, and MAIL_FROM are required.' };
  try { await mailer.verify(); return { ready: true, reason: 'SMTP connection and authentication are ready.' }; }
  catch (cause) {
    const reason = cause.code === 'EAUTH' ? 'Authentication failed. Check the Gmail address and App Password.' : 'The SMTP server could not be reached. Check the host, port, and secure setting.';
    return { ready: false, reason };
  }
}

module.exports = { sendMail, mailer, checkMailer };
