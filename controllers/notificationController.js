const Notification = require('../models/Notification');

async function listNotifications(req, res) {
  const notifications = await Notification.find({ userId: req.session.user.id }).sort({ createdAt: -1 }).limit(50).lean();
  res.json({ notifications: notifications.map(item => ({ id: String(item._id), title: item.title, message: item.message, read: Boolean(item.readAt), createdAt: item.createdAt })) });
}

async function markRead(req, res) {
  const notification = await Notification.findOneAndUpdate({ _id: req.params.id, userId: req.session.user.id }, { readAt: new Date() }, { new: true });
  if (!notification) return res.status(404).json({ error: 'Notification not found.' });
  res.json({ ok: true });
}

module.exports = { listNotifications, markRead };
