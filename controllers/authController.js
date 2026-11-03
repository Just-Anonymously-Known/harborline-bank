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

function localOtp(code) {
  return process.env.NODE_ENV === 'production' ? {} : { devOtp: process.env.SMTP_HOST ? undefined : code };
}

async function register(req, res) {
  const name = String(req.body.name || '').trim().slice(0, 80);
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const emailOptIn = req.body.emailOptIn === true;
  if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !isStrongPassword(password, 12)) {
    return res.status(400).json({ error: 'Enter your name and a valid email. Passwords need 12+ characters with uppercase, lowercase, number, and special character.' });
  }
  if (await User.exists({ email })) return res.status(409).json({ error: 'An account already uses that email. Try signing in.' });

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const passwordHash = await bcrypt.hash(password, 12);
  const dbSession = await mongoose.startSession();
  try {
    await dbSession.withTransaction(async () => {
      const [user] = await User.create([{
        name, email, passwordHash, emailOptIn,
        onboarding: {
          phone: req.body.phone, dateOfBirth: req.body.dateOfBirth ? new Date(req.body.dateOfBirth) : undefined,
          nationality: req.body.nationality, countryOfResidence: req.body.countryOfResidence,
          streetAddress: req.body.streetAddress, city: req.body.city, region: req.body.region,
          postalCode: req.body.postalCode, addressCountry: req.body.addressCountry,
          employmentStatus: req.body.employmentStatus, sourceOfFunds: req.body.sourceOfFunds,
          monthlyDeposits: req.body.monthlyDeposits, accountPurpose: req.body.accountPurpose,
          taxResidence: req.body.taxResidence, termsAcceptedAt: req.body.termsAccepted ? new Date() : undefined
        },
        otpPurpose: 'signup', otpHash: hashOtp(code),
        otpExpires: new Date(Date.now() + 10 * 60 * 1000), otpAttempts: 0
      }], { session: dbSession });
      await Account.create([{ userId: user._id, accountNumber: await createAccountNumber(), accountType: 'checking', nickname: 'Everyday Checking' }], { session: dbSession });
      await Card.create([
        { userId: user._id, cardType: 'debit', last4: String(crypto.randomInt(0, 10000)).padStart(4, '0') },
        { userId: user._id, cardType: 'credit', last4: String(crypto.randomInt(0, 10000)).padStart(4, '0'), creditLimitCents: 500000 }
      ], { session: dbSession });
    });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'An account already uses that email. Try signing in.' });
    throw err;
  } finally { await dbSession.endSession(); }

  try {
    await sendMail({
      to: email, subject: 'Your Harborline verification code',
      text: `Your Harborline verification code is ${code}. It expires in 10 minutes.`,
      html: `<p>Your Harborline verification code is <strong>${code}</strong>.</p><p>It expires in 10 minutes. If you did not request it, you can ignore this message.</p>`
    });
  } catch (error) {
    const pendingUser = await User.findOne({ email, verified: false }).select('_id').lean();
    if (pendingUser) await Promise.all([
      Account.deleteMany({ userId: pendingUser._id }),
      Card.deleteMany({ userId: pendingUser._id }),
      User.deleteOne({ _id: pendingUser._id })
    ]);
    throw error;
  }
  req.session.pendingEmail = email;
  res.status(201).json({ message: 'Account created. Enter the code we emailed you.', ...localOtp(code) });
}

async function resendOtp(req, res) {
  const email = String(req.body.email || req.session.pendingEmail || '').trim().toLowerCase();
  const user = await User.findOne({ email }).select('+otpHash +otpExpires +otpAttempts +otpPurpose');
  if (!user || user.verified) return res.json({ message: 'If the account is awaiting verification, a fresh code has been sent.' });
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  user.otpHash = hashOtp(code);
  user.otpExpires = new Date(Date.now() + 10 * 60 * 1000);
  user.otpAttempts = 0;
  await user.save();
  await sendMail({
    to: email, subject: 'Your new Harborline verification code',
    text: `Your new Harborline verification code is ${code}. It expires in 10 minutes.`,
    html: `<p>Your new Harborline verification code is <strong>${code}</strong>.</p><p>It expires in 10 minutes.</p>`
  });
  res.json({ message: 'If the account is awaiting verification, a fresh code has been sent.', ...localOtp(code) });
}

async function verifyOtp(req, res) {
  const email = String(req.body.email || req.session.pendingEmail || '').trim().toLowerCase();
  const code = String(req.body.code || '').trim();
  const user = await User.findOne({ email }).select('+otpHash +otpExpires +otpAttempts +otpPurpose');
  let valid = false;
  if (user?.otpPurpose === 'signup' && user.otpHash && user.otpExpires > new Date() && user.otpAttempts < 5 && /^\d{6}$/.test(code)) {
    valid = crypto.timingSafeEqual(Buffer.from(user.otpHash), Buffer.from(hashOtp(code)));
  }
  if (!valid) {
    if (user && !user.verified) { user.otpAttempts += 1; await user.save(); }
    return res.status(400).json({ error: 'That code is invalid or expired. Request a new code and try again.' });
  }
  user.verified = true;
  user.otpHash = undefined;
  user.otpExpires = undefined;
  user.otpPurpose = undefined;
  user.otpAttempts = 0;
  await user.save();
  const sessionInfo = await establishSession(req, user);
  res.json({ user: safeUser(user), csrf: sessionInfo.csrf });
}

async function login(req, res) {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = await User.findOne({ email }).select('+passwordHash');
  if (!user || !await bcrypt.compare(password, user.passwordHash)) return res.status(401).json({ error: 'Email or password is incorrect.' });
  if (!user.verified) return res.status(403).json({ error: 'Verify your email before signing in.' });
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  user.otpHash = hashOtp(code); user.otpExpires = new Date(Date.now() + 10 * 60 * 1000); user.otpAttempts = 0; user.otpPurpose = 'login';
  await user.save();
  await sendMail({ to: user.email, subject: 'Your Harborline sign-in code', text: `Your Harborline sign-in code is ${code}. It expires in 10 minutes.`, html: `<p>Your Harborline sign-in code is <strong>${code}</strong>.</p><p>It expires in 10 minutes.</p>` });
  req.session.pendingAuthEmail = user.email;
  res.json({ requiresOtp: true, email: user.email, message: 'Enter the sign-in code sent to your email.', ...localOtp(code) });
}

async function verifyLoginOtp(req, res) {
  const email = String(req.body.email || req.session.pendingAuthEmail || '').trim().toLowerCase();
  const code = String(req.body.code || '').trim();
  const user = await User.findOne({ email }).select('+otpHash +otpExpires +otpAttempts +otpPurpose');
  let valid = false;
  if (user?.otpPurpose === 'login' && user.otpHash && user.otpExpires > new Date() && user.otpAttempts < 5 && /^\d{6}$/.test(code)) {
    valid = crypto.timingSafeEqual(Buffer.from(user.otpHash), Buffer.from(hashOtp(code)));
  }
  if (!valid) {
    if (user) { user.otpAttempts += 1; await user.save(); }
    return res.status(400).json({ error: 'That sign-in code is invalid or expired.' });
  }
  user.otpHash = undefined; user.otpExpires = undefined; user.otpPurpose = undefined; user.otpAttempts = 0;
  await user.save();
  const sessionInfo = await establishSession(req, user);
  res.json({ user: safeUser(user), csrf: sessionInfo.csrf });
}

async function resendLoginOtp(req, res) {
  const email = String(req.body.email || req.session.pendingAuthEmail || '').trim().toLowerCase();
  const user = await User.findOne({ email }).select('+otpHash +otpExpires +otpAttempts +otpPurpose');
  if (!user || !user.verified || user.otpPurpose !== 'login') return res.json({ message: 'If a sign-in is pending, a new code has been sent.' });
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  user.otpHash = hashOtp(code); user.otpExpires = new Date(Date.now() + 10 * 60 * 1000); user.otpAttempts = 0;
  await user.save();
  await sendMail({ to: email, subject: 'Your new Harborline sign-in code', text: `Your new sign-in code is ${code}. It expires in 10 minutes.`, html: `<p>Your new sign-in code is <strong>${code}</strong>.</p><p>It expires in 10 minutes.</p>` });
  res.json({ message: 'If a sign-in is pending, a new code has been sent.', ...localOtp(code) });
}

async function requestPasswordReset(req, res) {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = await User.findOne({ email });
  if (!user || !user.verified) return res.json({ message: 'If the account exists, a reset code has been sent.' });
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  user.otpHash = hashOtp(code); user.otpExpires = new Date(Date.now() + 10 * 60 * 1000); user.otpAttempts = 0; user.otpPurpose = 'reset';
  await user.save();
  await sendMail({ to: user.email, subject: 'Reset your Harborline password', text: `Your password reset code is ${code}. It expires in 10 minutes.`, html: `<p>Your password reset code is <strong>${code}</strong>.</p><p>It expires in 10 minutes.</p>` });
  res.json({ message: 'If the account exists, a reset code has been sent.', ...localOtp(code) });
}

async function resetPassword(req, res) {
  const email = String(req.body.email || '').trim().toLowerCase();
  const code = String(req.body.code || '').trim();
  const password = String(req.body.password || '');
  if (!isStrongPassword(password, 12)) return res.status(400).json({ error: 'Choose a password with 12+ characters, including uppercase, lowercase, number, and special character.' });
  const user = await User.findOne({ email }).select('+otpHash +otpExpires +otpAttempts +otpPurpose');
  let valid = false;
  if (user?.otpPurpose === 'reset' && user.otpHash && user.otpExpires > new Date() && user.otpAttempts < 5 && /^\d{6}$/.test(code)) {
    valid = crypto.timingSafeEqual(Buffer.from(user.otpHash), Buffer.from(hashOtp(code)));
  }
  if (!valid) {
    if (user) { user.otpAttempts += 1; await user.save(); }
    return res.status(400).json({ error: 'That reset code is invalid or expired.' });
  }
  user.passwordHash = await bcrypt.hash(password, 12);
  user.otpHash = undefined; user.otpExpires = undefined; user.otpPurpose = undefined; user.otpAttempts = 0;
  await user.save();
  const sessions = await DeviceSession.find({ userId: user._id }).select('sessionId').lean();
  if (sessions.length) await mongoose.connection.collection('web_sessions').deleteMany({ _id: { $in: sessions.map(item => item.sessionId) } });
  await DeviceSession.deleteMany({ userId: user._id });
  res.json({ message: 'Password updated. Sign in with your new password.' });
}

function logout(req, res) {
  const sessionId = req.sessionID;
  DeviceSession.deleteOne({ sessionId }).catch(() => {}).then(() => {
    req.session.destroy(() => { res.clearCookie('harborline.sid'); res.json({ ok: true }); });
  });
}

module.exports = { register, resendOtp, verifyOtp, login, verifyLoginOtp, resendLoginOtp, requestPasswordReset, resetPassword, logout };
