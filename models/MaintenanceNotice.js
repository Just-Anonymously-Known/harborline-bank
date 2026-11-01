const mongoose = require('mongoose');

const maintenanceNoticeSchema = new mongoose.Schema({
  _id: { type: String, default: 'global' },
  active: { type: Boolean, default: false },
  title: { type: String, maxlength: 120, default: '' },
  message: { type: String, maxlength: 1000, default: '' },
  startsAt: { type: Date },
  endsAt: { type: Date },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

module.exports = mongoose.model('MaintenanceNotice', maintenanceNoticeSchema);
