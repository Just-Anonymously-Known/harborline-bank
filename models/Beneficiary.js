const mongoose = require('mongoose');
const beneficiarySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  accountNumber: { type: String, required: true, match: /^\d{10}$/ },
  name: { type: String, required: true, trim: true, maxlength: 80 }
}, { timestamps: true });
beneficiarySchema.index({ userId: 1, accountNumber: 1 }, { unique: true });
module.exports = mongoose.model('Beneficiary', beneficiarySchema);
