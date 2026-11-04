const nodemailer = require('nodemailer');

// Email over HTTPS (Brevo). Render's free plan blocks SMTP ports, so use this there.
// Set BREVO_API_KEY and MAIL_FROM (e.g. Harborline <you@gmail.com>, the sender verified in Brevo).
const useBrevo = Boolean(process.env.BREVO_API_KEY);

function parseSender(value) {
  const match = String(value || '').match(/^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/);
  return match ? { name: (match[1] || '').trim() || 'Harborline', email: match[2].trim() } : { name: 'Harborline', email: String(value || '').trim() };
}

async function sendViaBrevo({ to, subject, text, html, attachments }) {
  if (!process.env.MAIL_FROM) {
    const error = new Error('Email settings are incomplete. Add MAIL_FROM.');
    error.status = 503; error.code = 'EMAIL_DELIVERY'; throw error;
  }
  let response;
  try {
    response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sender: parseSender(process.env.MAIL_FROM), to: [{ email: to }], subject, textContent: text, htmlContent: html || `<p>${text}</p>`,
        ...(attachments?.length ? { attachment: attachments.map(file => ({ name: file.filename, content: Buffer.from(file.content).toString('base64') })) } : {}) }),
      
      signal: AbortSignal.timeout(attachments?.length ? 25000 : 15000)
    });
  } catch (cause) {
    console.error('Brevo request failed:', cause.name, cause.message);
    const error = new Error('Could not reach the email service. Please try again.'); error.status = 503; error.code = 'EMAIL_DELIVERY'; throw error;
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    console.error('Brevo rejected the email:', response.status, detail.slice(0, 300));
    const message = response.status === 401
      ? 'Email service key is invalid. Check BREVO_API_KEY.'
      : 'The email service rejected the message. Check that the sender address is verified in Brevo.';
    const error = new Error(message); error.status = 503; error.code = 'EMAIL_DELIVERY'; throw error;
  }
  return { accepted: [to], rejected: [] };
}

const mailer = useBrevo ? { brevo: true } : process.env.SMTP_HOST ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_SECURE === 'true',
  connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
  auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined
}) : null;

async function sendMail({ to, subject, text, html, attachments }) {
  if (!mailer) {
    if (process.env.NODE_ENV === 'production') throw new Error('Email delivery is not configured.');
    console.log(`[LOCAL MAIL] to=${to} subject=${subject}\n${text}`);
    return { localOnly: true, accepted: [to], rejected: [] };
  }
  if (useBrevo) return sendViaBrevo({ to, subject, text, html, attachments });
  if (!process.env.SMTP_USER || !process.env.SMTP_PASSWORD || !process.env.MAIL_FROM) {
    const error = new Error('Email settings are incomplete. Add SMTP_USER, SMTP_PASSWORD, and MAIL_FROM.');
    error.status = 503; error.code = 'EMAIL_DELIVERY'; throw error;
  }
  try {
    return await mailer.sendMail({ from: process.env.MAIL_FROM, to, subject, text, html, attachments });
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
  if (useBrevo) return process.env.MAIL_FROM ? { ready: true, reason: 'Email service (Brevo) is configured.' } : { ready: false, reason: 'MAIL_FROM is required.' };
  if (!mailer) return { ready: false, reason: 'SMTP_HOST is missing.' };
  if (!process.env.SMTP_USER || !process.env.SMTP_PASSWORD || !process.env.MAIL_FROM) return { ready: false, reason: 'SMTP_USER, SMTP_PASSWORD, and MAIL_FROM are required.' };
  try { await mailer.verify(); return { ready: true, reason: 'SMTP connection and authentication are ready.' }; }
  catch (cause) {
    const reason = cause.code === 'EAUTH' ? 'Authentication failed. Check the Gmail address and App Password.' : 'The SMTP server could not be reached. Check the host, port, and secure setting.';
    return { ready: false, reason };
  }
}

module.exports = { sendMail, mailer, checkMailer };
