const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  title: { type: String, required: true, maxlength: 100 },
  message: { type: String, required: true, maxlength: 300 },
  readAt: { type: Date, default: null }
}, { timestamps: { createdAt: true, updatedAt: false } });

module.exports = mongoose.model('Notification', notificationSchema);
