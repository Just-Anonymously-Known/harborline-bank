const mongoose = require('mongoose');

const cardSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  cardType: { type: String, enum: ['debit', 'credit'], required: true },
  last4: { type: String, required: true },
  status: { type: String, enum: ['active', 'locked'], default: 'active' },
  creditLimitCents: { type: Number, default: 0 },
  balanceCents: { type: Number, default: 0 },
  rewardsPoints: { type: Number, default: 0 }
}, { timestamps: true });
cardSchema.index({ userId: 1, cardType: 1 }, { unique: true });

module.exports = mongoose.model('Card', cardSchema);
