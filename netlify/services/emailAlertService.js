const User = require('../models/User');
const { sendMail } = require('./emailService');
const { escapeHtml } = require('../utils/identity');

async function sendTransactionAlert(userId, subject, message) {
  try {
    const user = await User.findOne({ _id: userId, verified: true, transactionAlerts: true }).select('email');
    if (!user) return;
    const safeSubject = String(subject).replace(/[\r\n]/g, ' ').slice(0, 120);
    const safeMessage = String(message).slice(0, 400);
    await sendMail({
      to: user.email,
      subject: `[Harborline account alert] ${safeSubject}`,
      text: `${safeMessage}\n\nIf you do not recognize this activity, contact Harborline support.`,
      html: `<p>${escapeHtml(safeMessage)}</p><p>If you do not recognize this activity, contact Harborline support.</p>`
    });
  } catch (error) {
    console.error('Could not send transaction email alert:', error.message);
  }
}

module.exports = { sendTransactionAlert };
