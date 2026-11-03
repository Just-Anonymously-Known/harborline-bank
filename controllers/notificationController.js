const mongoose = require('mongoose');
const Notification = require('../models/Notification');

function getUserId(req) {
  return req.session?.user?.id;
}

function sendError(res, error, message) {
  console.error('[notificationController]', error);

  if (res.headersSent) return;

  res.status(500).json({ error: message });
}

async function listNotifications(req, res) {
  try {
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({
        error: 'Authentication required.'
      });
    }

    const notifications = await Notification.find({ userId })
      .sort({ createdAt: -1, _id: -1 })
      .limit(50)
      .lean();

    res.json({
      notifications: notifications.map(item => ({
        id: String(item._id),
        title: item.title,
        message: item.message,
        read: Boolean(item.readAt),
        createdAt: item.createdAt
      }))
    });
  } catch (error) {
    sendError(res, error, 'Unable to load notifications.');
  }
}

async function markRead(req, res) {
  try {
    const userId = getUserId(req);
    const notificationId = req.params.id;

    if (!userId) {
      return res.status(401).json({
        error: 'Authentication required.'
      });
    }

    if (!mongoose.isValidObjectId(notificationId)) {
      return res.status(400).json({
        error: 'Invalid notification ID.'
      });
    }

    const notification = await Notification.findOneAndUpdate(
      {
        _id: notificationId,
        userId
      },
      {
        $set: {
          readAt: new Date()
        }
      },
      {
        new: true,
        runValidators: true
      }
    ).lean();

    if (!notification) {
      return res.status(404).json({
        error: 'Notification not found.'
      });
    }

    res.json({ ok: true });
  } catch (error) {
    sendError(res, error, 'Unable to mark notification as read.');
  }
}

module.exports = {
  listNotifications,
  markRead
};