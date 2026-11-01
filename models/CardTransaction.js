const mongoose = require('mongoose');

const cardTransactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  cardId: { type: mongoose.Schema.Types.ObjectId, ref: 'Card', required: true },
  kind: { type: String, enum: ['purchase', 'payment'], required: true },
  amountCents: { type: Number, required: true, min: 1 },
  description: { type: String, required: true, maxlength: 100 },
  category: { type: String, default: 'Other' }
}, { timestamps: { createdAt: true, updatedAt: false } });

module.exports = mongoose.model('CardTransaction', cardTransactionSchema);
