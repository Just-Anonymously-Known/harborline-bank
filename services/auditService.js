const AuditLog = require('../models/AuditLog');
const { clientIp } = require('../utils/clientIp');

function recordAdminAction(req, action, targetId = '', details = {}) {
  return AuditLog.create({
    adminId: req.session.user.id,
    action,
    targetId: String(targetId),
    details: { ...details, ...(req.auditReason ? { reason: req.auditReason } : {}) },
    ip: clientIp(req)
  });
}

module.exports = { recordAdminAction };
