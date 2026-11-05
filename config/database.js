const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const User = require('../models/User');
const Account = require('../models/Account');
const Card = require('../models/Card');
const { isStrongPassword } = require('../utils/identity');

async function createAccountNumber() {
  for (let tries = 0; tries < 12; tries++) {
    const accountNumber = `74${crypto.randomInt(10000000, 99999999)}`;
    if (!await Account.exists({ accountNumber })) return accountNumber;
  }
  throw new Error('Could not allocate an account number.');
}

async function connectDatabase() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('Set MONGODB_URI in .env.');
  await mongoose.connect(uri, { autoIndex: true, maxPoolSize: 5, serverSelectionTimeoutMS: 15000 });
  const indexes = await Account.collection.indexes().catch(() => []);
  const legacyUniqueUserIndex = indexes.find(index => index.unique && index.key.userId === 1 && Object.keys(index.key).length === 1);
  if (legacyUniqueUserIndex) await Account.collection.dropIndex(legacyUniqueUserIndex.name);
  await User.updateMany({ transactionAlerts: { $exists: false } }, { $set: { transactionAlerts: true } });
  // One-time: customers still on the old $1,000 default limit move to the new default (admin-set limits are left alone later).
  try {
    await mongoose.connection.db.collection('meta').insertOne({ _id: 'daily-limit-default-v5', at: new Date() });
    const { DEFAULT_DAILY_LIMIT_CENTS } = require('../utils/finance');
    const moved = await User.updateMany({ role: 'customer', dailyTransferLimitCents: 100000 }, { $set: { dailyTransferLimitCents: DEFAULT_DAILY_LIMIT_CENTS } });
    console.log('Daily limit default updated for', moved.modifiedCount, 'customers.');
  } catch (error) { if (error.code !== 11000) console.error('Limit migration skipped:', error.message); }
  await Account.updateMany({ accountType: { $exists: false } }, { $set: { accountType: 'checking', nickname: 'Everyday Checking', status: 'active' } });
  await Promise.all([User.init(), Account.init(), Card.init()]);
  console.log('Connected to MongoDB.');
}

async function seedAdmin() {
  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || '');
  if (!email || !password) {
    if (process.env.NODE_ENV === 'production') throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD in production.');
    console.warn('Admin account is not configured. Add ADMIN_EMAIL and ADMIN_PASSWORD to .env.');
    return;
  }
  if (process.env.NODE_ENV === 'production' && !isStrongPassword(password, 16)) throw new Error('ADMIN_PASSWORD needs 16+ characters with uppercase, lowercase, number, and special character.');
  const passwordHash = await bcrypt.hash(password, 12);
  const admin = await User.findOneAndUpdate({ email }, {
    $set: { name: process.env.ADMIN_NAME || 'Harborline Admin', passwordHash, role: 'admin', adminRole: 'owner', verified: true },
    $setOnInsert: { email, emailOptIn: false },
    $unset: { otpHash: 1, otpExpires: 1, otpPurpose: 1, otpAttempts: 1 }
  }, { new: true, upsert: true, runValidators: true });
  if (!await Account.exists({ userId: admin._id, accountType: 'checking' })) {
    await Account.create({ userId: admin._id, accountNumber: await createAccountNumber(), accountType: 'checking', nickname: 'Everyday Checking' });
  }
  console.log(`Admin account ready for ${email}.`);
}

module.exports = { connectDatabase, seedAdmin, createAccountNumber };
