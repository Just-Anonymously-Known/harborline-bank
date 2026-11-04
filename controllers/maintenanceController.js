const MaintenanceNotice = require('../models/MaintenanceNotice');
const User = require('../models/User');
const MailLog = require('../models/MailLog');
const { mailer, sendMail, checkMailer } = require('../services/emailService');
const { recordAdminAction } = require('../services/auditService');
const { mapLimit } = require('../utils/async');
const { renderEmail } = require('../services/emailTemplates');

async function getPublicNotice(req, res) {
  const notice = await MaintenanceNotice.findById('global').lean();
  if (!notice || !notice.active || (notice.endsAt && notice.endsAt <= new Date())) return res.json({ notice: null });
  res.json({ notice: { title: notice.title, message: notice.message, startsAt: notice.startsAt, endsAt: notice.endsAt, activeNow: !notice.startsAt || notice.startsAt <= new Date() } });
}

async function getAdminNotice(req, res) {
  const notice = await MaintenanceNotice.findById('global').lean();
  res.json({ notice: notice ? { active: notice.active, title: notice.title, message: notice.message, startsAt: notice.startsAt, endsAt: notice.endsAt } : null });
}

async function scheduleNotice(req, res) {
  const title = String(req.body.title || '').trim().slice(0, 120);
  const message = String(req.body.message || '').trim().slice(0, 1000);
  const startsAt = new Date(req.body.startsAt);
  const endsAt = new Date(req.body.endsAt);
  if (title.length < 3 || message.length < 3 || !Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime()) || endsAt <= startsAt) {
    return res.status(400).json({ error: 'Add a title, message, and valid start and end times.' });
  }
  if (!mailer) return res.status(503).json({ error: 'Configure email delivery before sending a maintenance email.' });
  const smtp = await checkMailer();
  if (!smtp.ready) return res.status(503).json({ error: smtp.reason });
  const notice = await MaintenanceNotice.findByIdAndUpdate('global', {
    _id: 'global', active: true, title, message, startsAt, endsAt, updatedBy: req.session.user.id
  }, { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true });
  const recipients = await User.find({ role: 'customer', verified: true }).select('email').sort({ createdAt: 1 }).limit(500).lean();
  const startLabel = startsAt.toLocaleString('en-US', { timeZone: 'UTC', timeZoneName: 'short' });
  const endLabel = endsAt.toLocaleString('en-US', { timeZone: 'UTC', timeZoneName: 'short' });
  const subject = `Scheduled maintenance: ${title}`;
  const recipientResults = await mapLimit(recipients, 8, async recipient => {
    try {
      const info = await sendMail({
        to: recipient.email,
        subject: `[Harborline service notice] ${subject}`,
        text: `${message}\n\nScheduled from ${startLabel} until ${endLabel}.`,
        html: renderEmail({ title: title, intro: message, rows: [['Starts', startLabel], ['Ends', endLabel]] })
      });
      if (info?.rejected?.length) throw new Error('The email provider rejected the recipient address.');
      return { email: recipient.email, status: 'sent' };
    } catch (error) { return { email: recipient.email, status: 'failed', error: error.message }; }
  });
  const deliveredCount = recipientResults.filter(item => item.status === 'sent').length;
  const failedCount = recipientResults.length - deliveredCount;
  const deliveryStatus = failedCount === 0 ? 'sent' : deliveredCount ? 'partial' : 'failed';
  await MailLog.create({ adminId: req.session.user.id, subject, recipientCount: recipients.length, deliveredCount, failedCount, deliveryStatus, recipientResults, kind: 'maintenance' });
  await recordAdminAction(req, 'schedule_maintenance', 'global', { title, startsAt, endsAt, recipientCount: recipients.length, deliveredCount, failedCount });
  res.json({ message: `Maintenance notice scheduled: ${deliveredCount} emails sent, ${failedCount} failed.`, deliveryStatus, deliveredCount, failedCount, notice: { active: notice.active, title: notice.title, startsAt: notice.startsAt, endsAt: notice.endsAt } });
}

async function cancelNotice(req, res) {
  const notice = await MaintenanceNotice.findByIdAndUpdate('global', { active: false, updatedBy: req.session.user.id }, { new: true });
  if (!notice) return res.status(404).json({ error: 'No maintenance notice is scheduled.' });
  await recordAdminAction(req, 'cancel_maintenance', 'global', { title: notice.title });
  res.json({ message: 'Maintenance notice cancelled.' });
}

module.exports = { getPublicNotice, getAdminNotice, scheduleNotice, cancelNotice };
