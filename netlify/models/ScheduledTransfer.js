const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  fromAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true },
  toAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true },
  amountCents: { type: Number, required: true, min: 1 },
  memo: { type: String, required: true, maxlength: 100 },
  category: { type: String, default: 'Transfer' },
  scheduledAt: { type: Date, required: true, index: true },
  status: { type: String, enum: ['scheduled', 'processing', 'completed', 'failed', 'canceled'], default: 'scheduled', index: true },
  processingAt: Date,
  failureReason: { type: String, maxlength: 160 }
}, { timestamps: true });

schema.index({ status: 1, scheduledAt: 1 });
module.exports = mongoose.model('ScheduledTransfer', schema);
