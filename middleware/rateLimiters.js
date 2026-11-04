const { rateLimit } = require('express-rate-limit');
const { clientIp } = require('../utils/clientIp');

const shared = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: clientIp,
  validate: { trustProxy: false, xForwardedForHeader: false, keyGeneratorIpFallback: false }
};

const apiLimiter = rateLimit({ ...shared, windowMs: 15 * 60 * 1000, limit: 300 });
const emailLimiter = rateLimit({
  ...shared, windowMs: 60 * 60 * 1000, limit: 8,
  message: { error: 'Too many verification attempts. Try again later.' }
});
const otpLimiter = rateLimit({
  ...shared, windowMs: 15 * 60 * 1000, limit: 10,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' }
});

module.exports = { apiLimiter, emailLimiter, otpLimiter };
