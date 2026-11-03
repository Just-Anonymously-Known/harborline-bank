const mongoose = require('mongoose');

const ledgerEntrySchema = new mongoose.Schema({
  transferGroup: { type: String, required: true, index: true },
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true, index: true },
  counterpartyAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'Account' },
  counterpartyName: { type: String, maxlength: 80 },
  kind: { type: String, enum: ['funding', 'transfer_in', 'transfer_out', 'goal_contribution', 'goal_withdrawal', 'card_purchase', 'card_payment'], required: true },
  amountCents: { type: Number, required: true, min: 1 },
  balanceAfterCents: { type: Number, required: true, min: 0 },
  description: { type: String, required: true, maxlength: 100 },
  category: { type: String, enum: ['Transfer', 'Food & drink', 'Home & bills', 'Shopping', 'Transport', 'Health', 'Other'], default: 'Transfer' }
}, { timestamps: { createdAt: true, updatedAt: false } });
ledgerEntrySchema.index({ accountId: 1, createdAt: -1 });

module.exports = mongoose.model('LedgerEntry', ledgerEntrySchema);
