const Notification = require('../models/Notification');

function notify(userId, title, message, session) {
  const item = { userId, title, message: String(message).slice(0, 300) };
  return session ? Notification.create([item], { session }) : Notification.create(item);
}

module.exports = { notify };
