const crypto = require('crypto');

function hashOtp(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function safeUser(user) {
  return {
    id: String(user._id), name: user.name, email: user.email,
    role: user.role, adminRole: user.role === 'admin' ? (user.adminRole || 'operations') : undefined,
    verified: user.verified, emailOptIn: Boolean(user.emailOptIn), transactionAlerts: user.transactionAlerts !== false
  };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
}

function isStrongPassword(value, minimumLength = 12) {
  const password = String(value || '');
  return password.length >= minimumLength && password.length <= 128 &&
    /[A-Z]/.test(password) && /[a-z]/.test(password) && /[0-9]/.test(password) && /[^A-Za-z0-9]/.test(password);
}

module.exports = { hashOtp, safeUser, escapeHtml, isStrongPassword };
