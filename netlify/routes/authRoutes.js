const express = require('express');
const authController = require('../controllers/authController');
const { emailLimiter, otpLimiter } = require('../middleware/rateLimiters');

const router = express.Router();
router.post('/register', emailLimiter, authController.register);
router.post('/resend-otp', emailLimiter, authController.resendOtp);
router.post('/verify', otpLimiter, authController.verifyOtp);
router.post('/login', otpLimiter, authController.login);
router.post('/login/verify', otpLimiter, authController.verifyLoginOtp);
router.post('/login/resend-otp', emailLimiter, authController.resendLoginOtp);
router.post('/password/forgot', emailLimiter, authController.requestPasswordReset);
router.post('/password/reset', otpLimiter, authController.resetPassword);
router.post('/logout', authController.logout);

module.exports = router;
