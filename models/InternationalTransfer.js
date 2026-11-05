const mongoose = require('mongoose');

const internationalTransferSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  fromAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true },
  reference: { type: String, required: true, unique: true },
  amountCents: { type: Number, required: true, min: 1 },       // USD sent (before fee)
  feeCents: { type: Number, required: true, min: 0 },
  totalCents: { type: Number, required: true, min: 1 },        // amount + fee, debited from the account
  currency: { type: String, required: true, match: /^[A-Z]{3}$/ },
  rate: { type: Number, required: true, min: 0 },              // units of `currency` per 1 USD, locked at submission
  rateSource: { type: String, default: 'live' },
  receiveAmount: { type: Number, required: true, min: 0 },     // in `currency`
  recipientName: { type: String, required: true, trim: true, maxlength: 80 },
  recipientCountry: { type: String, required: true, match: /^[A-Z]{2}$/ },
  bankName: { type: String, required: true, trim: true, maxlength: 80 },
  swift: { type: String, required: true, uppercase: true, trim: true },
  accountOrIban: { type: String, required: true, uppercase: true, trim: true },
  purpose: { type: String, required: true, maxlength: 60 },
  note: { type: String, trim: true, maxlength: 100, default: '' },
  status: { type: String, enum: ['pending', 'completed', 'rejected', 'canceled'], default: 'pending', index: true },
  debitEntryId: { type: mongoose.Schema.Types.ObjectId, ref: 'LedgerEntry' },
  refundEntryId: { type: mongoose.Schema.Types.ObjectId, ref: 'LedgerEntry' },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reviewedAt: Date,
  reviewNote: { type: String, maxlength: 240, default: '' }
}, { timestamps: true });
internationalTransferSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('InternationalTransfer', internationalTransferSchema);
