const mongoose = require('mongoose');

const accountSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  accountNumber: { type: String, required: true, unique: true },
  accountType: { type: String, enum: ['checking', 'savings'], default: 'checking' },
  nickname: { type: String, trim: true, maxlength: 40, default: '' },
  status: { type: String, enum: ['active', 'frozen'], default: 'active', index: true },
  balanceCents: { type: Number, required: true, default: 0, min: 0 },
  currency: { type: String, default: 'USD' }
}, { timestamps: true });
accountSchema.index({ userId: 1, accountType: 1 }, { unique: true });

module.exports = mongoose.model('Account', accountSchema);
