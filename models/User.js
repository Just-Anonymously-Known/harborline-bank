const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  onboarding: {
    phone: { type: String, trim: true, maxlength: 30 },
    dateOfBirth: Date,
    nationality: { type: String, trim: true, maxlength: 80 },
    countryOfResidence: { type: String, trim: true, maxlength: 80 },
    streetAddress: { type: String, trim: true, maxlength: 160 },
    city: { type: String, trim: true, maxlength: 80 },
    region: { type: String, trim: true, maxlength: 80 },
    postalCode: { type: String, trim: true, maxlength: 20 },
    addressCountry: { type: String, trim: true, maxlength: 80 },
    employmentStatus: { type: String, trim: true, maxlength: 40 },
    sourceOfFunds: { type: String, trim: true, maxlength: 60 },
    monthlyDeposits: { type: String, trim: true, maxlength: 60 },
    accountPurpose: { type: String, trim: true, maxlength: 60 },
    taxResidence: { type: String, trim: true, maxlength: 80 },
    termsAcceptedAt: Date
  },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: ['customer', 'admin'], default: 'customer', index: true },
  adminRole: { type: String, enum: ['owner', 'operations', 'auditor'], default: 'operations' },
  verified: { type: Boolean, default: false },
  emailOptIn: { type: Boolean, default: false },
  transactionAlerts: { type: Boolean, default: true },
  dailyTransferLimitCents: { type: Number, default: () => require('../utils/finance').DEFAULT_DAILY_LIMIT_CENTS, min: 100 },
  transferReviewThresholdCents: { type: Number, default: 0, min: 0 },
  otpHash: { type: String, select: false },
  otpExpires: { type: Date, select: false },
  otpAttempts: { type: Number, default: 0, select: false },
  otpPurpose: { type: String, enum: ['signup', 'login', 'reset'], select: false }
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
