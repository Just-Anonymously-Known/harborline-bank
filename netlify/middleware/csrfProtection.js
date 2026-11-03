const crypto = require('crypto');
const { isAllowedOrigin, normalizeOrigin } = require('../utils/origins');

function attachCsrfRoutes(req, res) {
  req.session.csrf ||= crypto.randomBytes(32).toString('hex');
  res.json({ token: req.session.csrf });
}

function requireSameOriginAndCsrf(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) || !req.path.startsWith('/api/')) return next();
  const requestOrigin = req.get('origin');
  const sameHost = requestOrigin && normalizeOrigin(requestOrigin) === normalizeOrigin(`${req.protocol}://${req.get('host')}`);
  if (requestOrigin && !sameHost && !isAllowedOrigin(requestOrigin)) return res.status(403).json({ error: 'Request origin not allowed.' });
  if (!req.session.csrf || req.get('x-csrf-token') !== req.session.csrf) return res.status(403).json({ error: 'Refresh the page and try again.' });
  next();
}

module.exports = { attachCsrfRoutes, requireSameOriginAndCsrf };
