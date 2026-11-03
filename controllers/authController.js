const crypto = require('crypto');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const User = require('../models/User');
const Account = require('../models/Account');
const Card = require('../models/Card');
const DeviceSession = require('../models/DeviceSession');

const { createAccountNumber } = require('../config/database');
const { sendMail } = require('../services/emailService');
const { establishSession } = require('../services/sessionService');
const { hashOtp, safeUser, isStrongPassword } = require('../utils/identity');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OTP_REGEX = /^\d{6}$/;
const OTP_EXPIRY_MS = 10 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function localOtp(code) {
  return process.env.NODE_ENV === 'production'
    ? {}
    : {
        devOtp: process.env.SMTP_HOST ? undefined : code
      };
}

function createOtp() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function setOtp(user, code, purpose) {
  user.otpHash = hashOtp(code);
  user.otpExpires = new Date(Date.now() + OTP_EXPIRY_MS);
  user.otpAttempts = 0;
  user.otpPurpose = purpose;
}

function isValidOtp(user, code, purpose) {
  if (
    !user ||
    user.otpPurpose !== purpose ||
    !user.otpHash ||
    !user.otpExpires ||
    user.otpExpires <= new Date() ||
    user.otpAttempts >= MAX_OTP_ATTEMPTS ||
    !OTP_REGEX.test(code)
  ) {
    return false;
  }

  const storedHash = Buffer.from(String(user.otpHash));
  const submittedHash = Buffer.from(String(hashOtp(code)));

  // timingSafeEqual throws if the buffers have different lengths.
  if (storedHash.length !== submittedHash.length) {
    return false;
  }

  return crypto.timingSafeEqual(storedHash, submittedHash);
}

function clearOtp(user) {
  user.otpHash = undefined;
  user.otpExpires = undefined;
  user.otpPurpose = undefined;
  user.otpAttempts = 0;
}

async function sendVerificationEmail(email, code) {
  await sendMail({
    to: email,
    subject: 'Your Harborline verification code',
    text: `Your Harborline verification code is ${code}. It expires in 10 minutes.`,
    html:
      `<p>Your Harborline verification code is <strong>${code}</strong>.</p>` +
      `<p>It expires in 10 minutes. If you did not request it, you can ignore this message.</p>`
  });
}

async function sendLoginEmail(email, code, isResend = false) {
  const subject = isResend
    ? 'Your new Harborline sign-in code'
    : 'Your Harborline sign-in code';

  const text = isResend
    ? `Your new Harborline sign-in code is ${code}. It expires in 10 minutes.`
    : `Your Harborline sign-in code is ${code}. It expires in 10 minutes.`;

  const html = isResend
    ? `<p>Your new sign-in code is <strong>${code}</strong>.</p><p>It expires in 10 minutes.</p>`
    : `<p>Your Harborline sign-in code is <strong>${code}</strong>.</p><p>It expires in 10 minutes.</p>`;

  await sendMail({
    to: email,
    subject,
    text,
    html
  });
}

async function sendPasswordResetEmail(email, code) {
  await sendMail({
    to: email,
    subject: 'Reset your Harborline password',
    text: `Your password reset code is ${code}. It expires in 10 minutes.`,
    html:
      `<p>Your password reset code is <strong>${code}</strong>.</p>` +
      `<p>It expires in 10 minutes.</p>`
  });
}

async function register(req, res) {
  const name = String(req.body?.name || '').trim().slice(0, 80);
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || '');
  const emailOptIn = req.body?.emailOptIn === true;

  if (
    name.length < 2 ||
    !EMAIL_REGEX.test(email) ||
    !isStrongPassword(password, 12)
  ) {
    return res.status(400).json({
      error:
        'Enter your name and a valid email. Passwords need 12+ characters with uppercase, lowercase, number, and special character.'
    });
  }

  if (await User.exists({ email })) {
    return res.status(409).json({
      error: 'An account already uses that email. Try signing in.'
    });
  }

  const code = createOtp();
  const passwordHash = await bcrypt.hash(password, 12);
  const dbSession = await mongoose.startSession();

  let createdUserId;

  try {
    await dbSession.withTransaction(async () => {
      const [user] = await User.create(
        [
          {
            name,
            email,
            passwordHash,
            emailOptIn,
            onboarding: {
              phone: req.body?.phone,
              dateOfBirth: req.body?.dateOfBirth
                ? new Date(req.body.dateOfBirth)
                : undefined,
              nationality: req.body?.nationality,
              countryOfResidence: req.body?.countryOfResidence,
              streetAddress: req.body?.streetAddress,
              city: req.body?.city,
              region: req.body?.region,
              postalCode: req.body?.postalCode,
              addressCountry: req.body?.addressCountry,
              employmentStatus: req.body?.employmentStatus,
              sourceOfFunds: req.body?.sourceOfFunds,
              monthlyDeposits: req.body?.monthlyDeposits,
              accountPurpose: req.body?.accountPurpose,
              taxResidence: req.body?.taxResidence,
              termsAcceptedAt: req.body?.termsAccepted
                ? new Date()
                : undefined
            },
            otpPurpose: 'signup',
            otpHash: hashOtp(code),
            otpExpires: new Date(Date.now() + OTP_EXPIRY_MS),
            otpAttempts: 0
          }
        ],
        { session: dbSession }
      );

      createdUserId = user._id;

      await Account.create(
        [
          {
            userId: user._id,
            accountNumber: await createAccountNumber(),
            accountType: 'checking',
            nickname: 'Everyday Checking'
          }
        ],
        { session: dbSession }
      );

      // FIX: ordered: true is required for multiple documents
      // created with a MongoDB session.
      await Card.create(
        [
          {
            userId: user._id,
            cardType: 'debit',
            last4: String(crypto.randomInt(0, 10000)).padStart(4, '0')
          },
          {
            userId: user._id,
            cardType: 'credit',
            last4: String(crypto.randomInt(0, 10000)).padStart(4, '0'),
            creditLimitCents: 500000
          }
        ],
        {
          session: dbSession,
          ordered: true
        }
      );
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        error: 'An account already uses that email. Try signing in.'
      });
    }

    throw error;
  } finally {
    await dbSession.endSession();
  }

  try {
    await sendVerificationEmail(email, code);
  } catch (error) {
    console.error('[authController] Registration email failed:', error.message);

    // Remove the pending registration if its verification email could
    // not be sent, preserving the behavior of your original controller.
    if (createdUserId) {
      await Promise.all([
        Account.deleteMany({ userId: createdUserId }),
        Card.deleteMany({ userId: createdUserId }),
        User.deleteOne({ _id: createdUserId, verified: false })
      ]);
    }

    throw error;
  }

  req.session.pendingEmail = email;

  return res.status(201).json({
    message: 'Account created. Enter the code we emailed you.',
    ...localOtp(code)
  });
}

async function resendOtp(req, res) {
  const email = normalizeEmail(req.body?.email || req.session.pendingEmail);

  const user = await User.findOne({ email }).select(
    '+otpHash +otpExpires +otpAttempts +otpPurpose'
  );

  if (!user || user.verified) {
    return res.json({
      message: 'If the account is awaiting verification, a fresh code has been sent.'
    });
  }

  const code = createOtp();

  setOtp(user, code, 'signup');
  await user.save();

  await sendVerificationEmail(email, code);

  return res.json({
    message: 'If the account is awaiting verification, a fresh code has been sent.',
    ...localOtp(code)
  });
}

async function verifyOtp(req, res) {
  const email = normalizeEmail(req.body?.email || req.session.pendingEmail);
  const code = String(req.body?.code || '').trim();

  const user = await User.findOne({ email }).select(
    '+otpHash +otpExpires +otpAttempts +otpPurpose'
  );

  const valid = isValidOtp(user, code, 'signup');

  if (!valid) {
    if (user && !user.verified) {
      user.otpAttempts = (user.otpAttempts || 0) + 1;
      await user.save();
    }

    return res.status(400).json({
      error: 'That code is invalid or expired. Request a new code and try again.'
    });
  }

  user.verified = true;
  clearOtp(user);

  await user.save();

  const sessionInfo = await establishSession(req, user);

  return res.json({
    user: safeUser(user),
    csrf: sessionInfo.csrf
  });
}

async function login(req, res) {
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || '');

  const user = await User.findOne({ email }).select('+passwordHash');

  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({
      error: 'Email or password is incorrect.'
    });
  }

  if (!user.verified) {
    return res.status(403).json({
      error: 'Verify your email before signing in.'
    });
  }

  const code = createOtp();

  setOtp(user, code, 'login');
  await user.save();

  await sendLoginEmail(user.email, code);

  req.session.pendingAuthEmail = user.email;

  return res.json({
    requiresOtp: true,
    email: user.email,
    message: 'Enter the sign-in code sent to your email.',
    ...localOtp(code)
  });
}

async function verifyLoginOtp(req, res) {
  const email = normalizeEmail(
    req.body?.email || req.session.pendingAuthEmail
  );

  const code = String(req.body?.code || '').trim();

  const user = await User.findOne({ email }).select(
    '+otpHash +otpExpires +otpAttempts +otpPurpose'
  );

  const valid = isValidOtp(user, code, 'login');

  if (!valid) {
    if (user) {
      user.otpAttempts = (user.otpAttempts || 0) + 1;
      await user.save();
    }

    return res.status(400).json({
      error: 'That sign-in code is invalid or expired.'
    });
  }

  clearOtp(user);
  await user.save();

  const sessionInfo = await establishSession(req, user);

  return res.json({
    user: safeUser(user),
    csrf: sessionInfo.csrf
  });
}

async function resendLoginOtp(req, res) {
  const email = normalizeEmail(
    req.body?.email || req.session.pendingAuthEmail
  );

  const user = await User.findOne({ email }).select(
    '+otpHash +otpExpires +otpAttempts +otpPurpose'
  );

  if (!user || !user.verified || user.otpPurpose !== 'login') {
    return res.json({
      message: 'If a sign-in is pending, a new code has been sent.'
    });
  }

  const code = createOtp();

  setOtp(user, code, 'login');
  await user.save();

  await sendLoginEmail(email, code, true);

  return res.json({
    message: 'If a sign-in is pending, a new code has been sent.',
    ...localOtp(code)
  });
}

async function requestPasswordReset(req, res) {
  const email = normalizeEmail(req.body?.email);

  const user = await User.findOne({ email });

  if (!user || !user.verified) {
    return res.json({
      message: 'If the account exists, a reset code has been sent.'
    });
  }

  const code = createOtp();

  setOtp(user, code, 'reset');
  await user.save();

  await sendPasswordResetEmail(user.email, code);

  return res.json({
    message: 'If the account exists, a reset code has been sent.',
    ...localOtp(code)
  });
}

async function resetPassword(req, res) {
  const email = normalizeEmail(req.body?.email);
  const code = String(req.body?.code || '').trim();
  const password = String(req.body?.password || '');

  if (!isStrongPassword(password, 12)) {
    return res.status(400).json({
      error:
        'Choose a password with 12+ characters, including uppercase, lowercase, number, and special character.'
    });
  }

  const user = await User.findOne({ email }).select(
    '+otpHash +otpExpires +otpAttempts +otpPurpose'
  );

  const valid = isValidOtp(user, code, 'reset');

  if (!valid) {
    if (user) {
      user.otpAttempts = (user.otpAttempts || 0) + 1;
      await user.save();
    }

    return res.status(400).json({
      error: 'That reset code is invalid or expired.'
    });
  }

  user.passwordHash = await bcrypt.hash(password, 12);
  clearOtp(user);

  await user.save();

  const sessions = await DeviceSession.find({ userId: user._id })
    .select('sessionId')
    .lean();

  if (sessions.length) {
    await mongoose.connection
      .collection('web_sessions')
      .deleteMany({
        _id: {
          $in: sessions.map(item => item.sessionId)
        }
      });
  }

  await DeviceSession.deleteMany({ userId: user._id });

  return res.json({
    message: 'Password updated. Sign in with your new password.'
  });
}

function logout(req, res) {
  const sessionId = req.sessionID;

  DeviceSession.deleteOne({ sessionId })
    .catch(() => {})
    .then(() => {
      req.session.destroy(() => {
        res.clearCookie('harborline.sid');
        res.json({ ok: true });
      });
    });
}

module.exports = {
  register,
  resendOtp,
  verifyOtp,
  login,
  verifyLoginOtp,
  resendLoginOtp,
  requestPasswordReset,
  resetPassword,
  logout
};