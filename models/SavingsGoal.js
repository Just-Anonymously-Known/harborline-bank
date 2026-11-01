const mongoose = require('mongoose');

const savingsGoalSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 60 },
  targetCents: { type: Number, required: true, min: 100 },
  savedCents: { type: Number, required: true, default: 0, min: 0 },
  status: { type: String, enum: ['active', 'complete'], default: 'active' }
}, { timestamps: true });

module.exports = mongoose.model('SavingsGoal', savingsGoalSchema);
