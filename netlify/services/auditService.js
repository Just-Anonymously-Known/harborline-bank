const AuditLog = require('../models/AuditLog');

function recordAdminAction(req, action, targetId = '', details = {}) {
  return AuditLog.create({
    adminId: req.session.user.id,
    action,
    targetId: String(targetId),
    details: { ...details, ...(req.auditReason ? { reason: req.auditReason } : {}) },
    ip: String(req.ip || '').slice(0, 80)
  });
}

module.exports = { recordAdminAction };
