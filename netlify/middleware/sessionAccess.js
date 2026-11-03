function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Sign in to continue.' });
  if (!req.session.user.verified) return res.status(403).json({ error: 'Verify your email to continue.' });
  next();
}

async function requireAdmin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Sign in to continue.' });
  const User = require('../models/User');
  const user = await User.findById(req.session.user.id).select('role adminRole verified').lean();
  if (!user || !user.verified || user.role !== 'admin') return res.status(403).json({ error: 'Administrator access required.' });
  req.session.user.adminRole = user.adminRole || 'operations';
  req.adminRole = req.session.user.adminRole;
  next();
}

function requirePermission(...roles) {
  return (req, res, next) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(401).json({ error: 'Administrator access required.' });
    if (!roles.includes(req.adminRole || req.session.user.adminRole || 'operations')) return res.status(403).json({ error: 'Your administrator role cannot perform this action.' });
    next();
  };
}

function requireAuditReason(req, res, next) {
  const reason = String(req.body.reason || '').trim().slice(0, 240);
  if (reason.length < 5) return res.status(400).json({ error: 'Enter a reason of at least 5 characters for the audit record.' });
  req.auditReason = reason;
  next();
}

module.exports = { requireAuth, requireAdmin, requirePermission, requireAuditReason };
