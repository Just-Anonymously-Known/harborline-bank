const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: ['customer', 'admin'], default: 'customer', index: true },
  adminRole: { type: String, enum: ['owner', 'operations', 'auditor'], default: 'operations' },
  verified: { type: Boolean, default: false },
  emailOptIn: { type: Boolean, default: false },
  transactionAlerts: { type: Boolean, default: true },
  dailyTransferLimitCents: { type: Number, default: 100000, min: 100 },
  transferReviewThresholdCents: { type: Number, default: 0, min: 0 },
  otpHash: { type: String, select: false },
  otpExpires: { type: Date, select: false },
  otpAttempts: { type: Number, default: 0, select: false },
  otpPurpose: { type: String, enum: ['signup', 'login', 'reset'], select: false }
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
