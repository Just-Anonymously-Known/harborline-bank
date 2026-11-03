const mongoose = require('mongoose');
const supportTicketSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  email: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
  name: { type: String, trim: true, maxlength: 80 },
  subject: { type: String, required: true, trim: true, maxlength: 120 },
  category: { type: String, enum: ['General question','Account access','Card issue','Transfer issue','Savings','Security concern','Other'], default: 'General question' },
  message: { type: String, required: true, maxlength: 5000 },
  status: { type: String, enum: ['open','in_progress','resolved'], default: 'open', index: true },
  replies: [{ author: { type: String, enum: ['customer','support'], required: true }, message: { type: String, required: true, maxlength: 5000 }, createdAt: { type: Date, default: Date.now } }]
}, { timestamps: true });
module.exports = mongoose.model('SupportTicket', supportTicketSchema);
