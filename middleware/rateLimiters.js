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

const lookupLimiter = rateLimit({
  ...shared, windowMs: 10 * 60 * 1000, limit: 60,
  message: { error: 'Too many account look-ups. Please wait a few minutes.' }
});
const supportLimiter = rateLimit({
  ...shared, windowMs: 60 * 60 * 1000, limit: 20,
  message: { error: 'Too many support messages. Please try again later.' }
});

module.exports = { apiLimiter, emailLimiter, otpLimiter, lookupLimiter, supportLimiter };
