const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  fromAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true },
  toAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true },
  amountCents: { type: Number, required: true, min: 1 },
  memo: { type: String, maxlength: 100, required: true },
  category: { type: String, default: 'Transfer' },
  status: { type: String, enum: ['pending', 'processing', 'approved', 'rejected'], default: 'pending', index: true },
  reviewReason: { type: String, maxlength: 240 },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reviewedAt: Date
}, { timestamps: true });

schema.index({ status: 1, createdAt: -1 });
module.exports = mongoose.model('TransferReview', schema);
