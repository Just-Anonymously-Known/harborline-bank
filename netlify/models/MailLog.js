const mongoose = require('mongoose');

const mailLogSchema = new mongoose.Schema({
  adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  subject: { type: String, required: true, maxlength: 120 },
  recipientCount: { type: Number, required: true },
  deliveredCount: { type: Number, default: 0 },
  failedCount: { type: Number, default: 0 },
  deliveryStatus: { type: String, enum: ['sent', 'partial', 'failed'], default: 'sent' },
  recipientResults: [{ email: { type: String, maxlength: 254 }, status: { type: String, enum: ['sent', 'failed'] }, error: { type: String, maxlength: 240 } }],
  kind: { type: String, enum: ['general', 'maintenance', 'service'], default: 'general' }
}, { timestamps: { createdAt: true, updatedAt: false } });

module.exports = mongoose.model('MailLog', mailLogSchema);
