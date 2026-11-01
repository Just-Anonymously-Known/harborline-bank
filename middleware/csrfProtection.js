const crypto = require('crypto');

function attachCsrfRoutes(req, res) {
  req.session.csrf ||= crypto.randomBytes(32).toString('hex');
  res.json({ token: req.session.csrf });
}

function requireSameOriginAndCsrf(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) || !req.path.startsWith('/api/')) return next();
  const expectedOrigin = process.env.APP_ORIGIN || `${req.protocol}://${req.get('host')}`;
  const requestOrigin = req.get('origin');
  if (requestOrigin && requestOrigin !== expectedOrigin) return res.status(403).json({ error: 'Request origin not allowed.' });
  if (!req.session.csrf || req.get('x-csrf-token') !== req.session.csrf) return res.status(403).json({ error: 'Refresh the page and try again.' });
  next();
}

module.exports = { attachCsrfRoutes, requireSameOriginAndCsrf };
