
const crypto = require('crypto');
const mongoose = require('mongoose');

const User = require('../models/User');
const Account = require('../models/Account');
const LedgerEntry = require('../models/LedgerEntry');
const MailLog = require('../models/MailLog');
const AuditLog = require('../models/AuditLog');
const TransferReview = require('../models/TransferReview');

const { cents, money } = require('../utils/finance');
const { escapeHtml, isStrongPassword } = require('../utils/identity');
const { sendMail, mailer, checkMailer } = require('../services/emailService');
const { createAccountNumber } = require('../config/database');
const { recordAdminAction } = require('../services/auditService');
const { notify } = require('../services/notificationService');
const { sendTransactionAlert } = require('../services/emailAlertService');
const { statementHtml } = require('../services/statementService');

async function listAccounts(req, res) {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 25));
  const search = String(req.query.search || '').trim().slice(0, 80);
  const escapedSearch = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const filter = { role: 'customer' };

  if (escapedSearch) {
    const accountUserIds = await Account.distinct('userId', {
      accountNumber: { $regex: escapedSearch, $options: 'i' }
    });

    filter.$or = [
      { name: { $regex: escapedSearch, $options: 'i' } },
      { email: { $regex: escapedSearch, $options: 'i' } },
      { _id: { $in: accountUserIds } }
    ];
  }

  const [users, total] = await Promise.all([
    User.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    User.countDocuments(filter)
  ]);

  const accounts = await Account.find({
    userId: { $in: users.map(user => user._id) }
  }).lean();

  const byUser = new Map(accounts.map(account => [String(account.userId), account]));

  const counts = await LedgerEntry.aggregate([
    { $match: { accountId: { $in: accounts.map(account => account._id) } } },
    { $group: { _id: '$accountId', count: { $sum: 1 } } }
  ]);

  const countMap = new Map(counts.map(item => [String(item._id), item.count]));

  const rows = users.flatMap(user => {
    const account = byUser.get(String(user._id));

    if (!account) {
      return [{
        id: String(user._id),
        name: user.name,
        email: user.email,
        verified: user.verified,
        created_at: user.createdAt,
        accountId: '',
        account_number: '',
        accountType: 'none',
        nickname: 'No account',
        status: 'missing',
        balance: '0.00',
        currency: 'USD',
        transaction_count: 0,
        email_opt_in: Boolean(user.emailOptIn),
        review_threshold: money(user.transferReviewThresholdCents || 0)
      }];
    }

    return accounts
      .filter(item => String(item.userId) === String(user._id))
      .map(item => ({
        id: String(user._id),
        name: user.name,
        email: user.email,
        verified: user.verified,
        created_at: user.createdAt,
        accountId: String(item._id),
        account_number: item.accountNumber,
        accountType: item.accountType,
        nickname: item.nickname,
        status: item.status,
        balance: money(item.balanceCents),
        currency: item.currency,
        transaction_count: countMap.get(String(item._id)) || 0,
        email_opt_in: Boolean(user.emailOptIn),
        review_threshold: money(user.transferReviewThresholdCents || 0)
      }));
  });

  res.json({
    accounts: rows,
    page,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    total
  });
}

async function fundAccount(req, res) {
  const email = String(req.body.email || '').trim().toLowerCase();
  const accountNumber = String(req.body.accountNumber || '').trim();
  const amount = cents(req.body.amount);
  const memo = String(req.body.memo || 'Funds added by administrator')
    .trim()
    .slice(0, 100) || 'Funds added by administrator';

  if (!amount || amount > 100000000) {
    return res.status(400).json({ error: 'Enter an amount up to $1,000,000.' });
  }

  const dbSession = await mongoose.startSession();
  let balance;
  let fundedUserId;

  try {
    await dbSession.withTransaction(async () => {
      const customer = email
        ? await User.findOne({ email, role: 'customer' }).session(dbSession)
        : null;

      const account = accountNumber
        ? await Account.findOne({ accountNumber }).session(dbSession)
        : customer
          ? await Account.findOne({
              userId: customer._id,
              accountType: 'checking'
            }).session(dbSession)
          : null;

      if (!account) {
        throw Object.assign(new Error('Customer account not found.'), { status: 404 });
      }

      const owner = await User.findOne({
        _id: account.userId,
        role: 'customer'
      }).session(dbSession);

      if (!owner) {
        throw Object.assign(new Error('Customer account not found.'), { status: 404 });
      }

      fundedUserId = owner._id;
      account.balanceCents += amount;
      balance = account.balanceCents;

      await account.save({ session: dbSession });

      await LedgerEntry.create([{
        transferGroup: crypto.randomUUID(),
        accountId: account._id,
        kind: 'funding',
        amountCents: amount,
        balanceAfterCents: balance,
        description: memo
      }], { session: dbSession, ordered: true });

      await notify(
        account.userId,
        'Funds added',
        `$${money(amount)} added to ${account.nickname || account.accountType}.`,
        dbSession
      );
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    throw err;
  } finally {
    await dbSession.endSession();
  }

  await sendTransactionAlert(
    fundedUserId,
    'Funds credited',
    `$${money(amount)} was added to your Harborline account.`
  );

  await recordAdminAction(req, 'fund_account', email || accountNumber, {
    amount: money(amount),
    memo
  });

  res.json({ message: `Added $${money(amount)}.`, balance: money(balance) });
}

async function createAccount(req, res) {
  const email = String(req.body.email || '').trim().toLowerCase();
  const accountType = req.body.accountType === 'savings' ? 'savings' : 'checking';
  const nickname = String(
    req.body.nickname || (accountType === 'savings' ? 'Savings' : 'Everyday Checking')
  ).trim().slice(0, 40);

  const user = await User.findOne({ email, role: 'customer' });
  if (!user) return res.status(404).json({ error: 'Customer not found.' });

  if (await Account.exists({ userId: user._id, accountType })) {
    return res.status(409).json({
      error: `Customer already has a ${accountType} account.`
    });
  }

  try {
    const account = await Account.create({
      userId: user._id,
      accountNumber: await createAccountNumber(),
      accountType,
      nickname
    });

    await recordAdminAction(req, 'create_account', account._id, {
      email,
      accountType,
      accountNumber: account.accountNumber
    });

    res.status(201).json({
      message: `${accountType} account created.`,
      accountNumber: account.accountNumber
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({
        error: 'That account type already exists for this customer.'
      });
    }
    throw err;
  }
}

async function setAccountNumber(req, res) {
  const accountNumber = String(req.body.accountNumber || '').trim();

  if (!/^\d{10}$/.test(accountNumber)) {
    return res.status(400).json({
      error: 'Account numbers must contain exactly 10 digits.'
    });
  }

  try {
    const account = await Account.findByIdAndUpdate(
      req.params.id,
      { accountNumber },
      { new: true, runValidators: true }
    );

    if (!account) return res.status(404).json({ error: 'Account not found.' });

    await recordAdminAction(req, 'change_account_number', account._id, { accountNumber });
    res.json({ message: 'Account number updated.', accountNumber });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'That account number is already in use.' });
    }
    throw err;
  }
}

async function setAccountStatus(req, res) {
  const status = req.body.status;

  if (!['active', 'frozen'].includes(status)) {
    return res.status(400).json({ error: 'Choose active or frozen.' });
  }

  const existing = await Account.findById(req.params.id);
  if (!existing || !await User.exists({ _id: existing.userId, role: 'customer' })) {
    return res.status(404).json({ error: 'Account not found.' });
  }

  const account = await Account.findByIdAndUpdate(
    req.params.id,
    { status },
    { new: true, runValidators: true }
  );

  if (!account) return res.status(404).json({ error: 'Account not found.' });

  await recordAdminAction(req, 'set_account_status', account._id, { status });
  await notify(
    account.userId,
    `Account ${status}`,
    `Your ${account.nickname || account.accountType} account is ${status}.`
  );

  res.json({ message: `Account ${status}.`, status });
}

async function accountActivity(req, res) {
  const account = await Account.findById(req.params.id).populate('userId', 'name email');
  if (!account) return res.status(404).json({ error: 'Account not found.' });

  const entries = await LedgerEntry.find({ accountId: account._id })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();

  res.json({
    owner: account.userId,
    account: {
      accountNumber: account.accountNumber,
      accountType: account.accountType,
      nickname: account.nickname,
      balance: money(account.balanceCents),
      status: account.status
    },
    activity: entries.map(entry => ({
      ...entry,
      amount: money(entry.amountCents),
      balanceAfter: money(entry.balanceAfterCents)
    }))
  });
}

async function downloadAccountStatement(req, res) {
  const start = req.query.start
    ? new Date(`${req.query.start}T00:00:00.000Z`)
    : new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));

  const end = req.query.end
    ? new Date(`${req.query.end}T23:59:59.999Z`)
    : new Date();

  if (
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    start > end ||
    end - start > 366 * 86400000
  ) {
    return res.status(400).json({
      error: 'Choose a valid statement period of no more than 12 months.'
    });
  }

  const account = await Account.findById(req.params.id).lean();
  if (!account) return res.status(404).json({ error: 'Account not found.' });

  const [owner, entries] = await Promise.all([
    User.findById(account.userId).select('name email').lean(),
    LedgerEntry.find({
      accountId: account._id,
      createdAt: { $gte: start, $lte: end }
    }).sort({ createdAt: 1 }).limit(5000).lean()
  ]);

  res.type('html')
    .set('Content-Disposition', 'attachment; filename="harborline-portfolio-statement.html"')
    .send(statementHtml({ owner, account, entries, start, end }));
}

async function setAdminRole(req, res) {
  const adminRole = String(req.body.adminRole || '');

  if (!['owner', 'operations', 'auditor'].includes(adminRole)) {
    return res.status(400).json({
      error: 'Choose owner, operations, or auditor.'
    });
  }

  if (String(req.params.id) === String(req.session.user.id) && adminRole !== 'owner') {
    return res.status(400).json({
      error: 'An owner cannot remove their own owner access.'
    });
  }

  const current = await User.findOne({
    _id: req.params.id,
    role: 'admin'
  }).select('adminRole');

  if (
    current?.adminRole === 'owner' &&
    adminRole !== 'owner' &&
    await User.countDocuments({ role: 'admin', adminRole: 'owner' }) <= 1
  ) {
    return res.status(400).json({
      error: 'Keep at least one owner administrator.'
    });
  }

  const user = await User.findOneAndUpdate(
    { _id: req.params.id, role: 'admin' },
    { adminRole },
    { new: true, runValidators: true }
  );

  if (!user) return res.status(404).json({ error: 'Administrator not found.' });

  await recordAdminAction(req, 'set_admin_role', user._id, { adminRole });
  res.json({ message: 'Administrator role updated.' });
}

async function createAdmin(req, res) {
  const name = String(req.body.name || '').trim().slice(0, 80);
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const adminRole = String(req.body.adminRole || 'auditor');

  if (
    name.length < 2 ||
    !email.includes('@') ||
    !email.includes('.') ||
    !isStrongPassword(password, 16) ||
    !['operations', 'auditor'].includes(adminRole)
  ) {
    return res.status(400).json({
      error: 'Enter a name, valid email, 16+ character password with uppercase, lowercase, number, and special character, and operations or auditor role.'
    });
  }

  try {
    const user = await User.create({
      name,
      email,
      passwordHash: await bcrypt.hash(password, 12),
      role: 'admin',
      adminRole,
      verified: true,
      emailOptIn: false
    });

    await recordAdminAction(req, 'create_admin', user._id, { email, adminRole });

    res.status(201).json({
      message: 'Administrator created. Sign-in requires email verification code.'
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'An account already uses that email.' });
    }
    throw err;
  }
}

async function setTransferLimit(req, res) {
  const limit = cents(req.body.amount);

  if (!limit || limit > 1000000000) {
    return res.status(400).json({
      error: 'Enter a daily limit up to $10,000,000.'
    });
  }

  const user = await User.findOneAndUpdate(
    { _id: req.params.id, role: 'customer' },
    { dailyTransferLimitCents: limit },
    { new: true, runValidators: true }
  );

  if (!user) return res.status(404).json({ error: 'Customer not found.' });

  await recordAdminAction(req, 'set_transfer_limit', user._id, {
    dailyLimit: money(limit)
  });

  res.json({ message: 'Daily transfer limit updated.', amount: money(limit) });
}

async function setTransferReviewThreshold(req, res) {
  const raw = String(req.body.amount ?? '').trim();
  const threshold = raw === '0' || raw === '0.00' ? 0 : cents(raw);

  if (threshold === null || threshold > 100000000) {
    return res.status(400).json({
      error: 'Enter 0 to disable review, or an amount up to $1,000,000.'
    });
  }

  const user = await User.findOneAndUpdate(
    { _id: req.params.id, role: 'customer' },
    { transferReviewThresholdCents: threshold },
    { new: true, runValidators: true }
  );

  if (!user) return res.status(404).json({ error: 'Customer not found.' });

  await recordAdminAction(req, 'set_transfer_review_threshold', user._id, {
    threshold: money(threshold)
  });

  res.json({
    message: threshold
      ? `Transfers of $${money(threshold)} or more will require review.`
      : 'Transfer review threshold disabled.'
  });
}

async function listTransferReviews(req, res) {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));

  await TransferReview.updateMany(
    {
      status: 'processing',
      updatedAt: { $lt: new Date(Date.now() - 5 * 60 * 1000) }
    },
    { $set: { status: 'pending' } }
  );

  const filter = { status: 'pending' };

  const [reviews, total] = await Promise.all([
    TransferReview.find(filter)
      .sort({ createdAt: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('userId', 'name email')
      .populate('fromAccountId', 'accountNumber nickname')
      .populate('toAccountId', 'accountNumber nickname')
      .lean(),
    TransferReview.countDocuments(filter)
  ]);

  res.json({
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
    total,
    reviews: reviews.map(item => ({
      id: String(item._id),
      amount: money(item.amountCents),
      memo: item.memo,
      category: item.category,
      createdAt: item.createdAt,
      customer: item.userId?.name || 'Customer',
      email: item.userId?.email || '',
      from: item.fromAccountId?.accountNumber || '',
      to: item.toAccountId?.accountNumber || ''
    }))
  });
}

async function resolveTransferReview(req, res) {
  const decision = String(req.body.decision || '');

  if (!['approve', 'reject'].includes(decision)) {
    return res.status(400).json({ error: 'Choose approve or reject.' });
  }

  const review = await TransferReview.findOneAndUpdate(
    { _id: req.params.id, status: 'pending' },
    { $set: { status: 'processing' } },
    { new: true }
  );

  if (!review) {
    return res.status(404).json({ error: 'Pending transfer review not found.' });
  }

  if (decision === 'reject') {
    review.status = 'rejected';
    review.reviewReason = req.auditReason;
    review.reviewedBy = req.session.user.id;
    review.reviewedAt = new Date();

    await review.save();
    await notify(
      review.userId,
      'Transfer not approved',
      'Your transfer request was not approved. Contact support if you need more information.'
    );
    await recordAdminAction(req, 'reject_transfer_review', review._id, {
      amount: money(review.amountCents)
    });

    return res.json({ message: 'Transfer request rejected.' });
  }

  const dbSession = await mongoose.startSession();
  let senderName;
  let recipientName;
  let recipientId;

  try {
    await dbSession.withTransaction(async () => {
      const locked = await Account.find({
        _id: { $in: [review.fromAccountId, review.toAccountId] }
      }).sort({ _id: 1 }).session(dbSession);

      const byId = new Map(locked.map(account => [String(account._id), account]));
      const from = byId.get(String(review.fromAccountId));
      const to = byId.get(String(review.toAccountId));

      const sender = await User.findOne({
        _id: review.userId,
        role: 'customer',
        verified: true
      }).session(dbSession);

      const recipient = to
        ? await User.findOne({
            _id: to.userId,
            role: 'customer',
            verified: true
          }).session(dbSession)
        : null;

      if (
        !from || !to || !sender || !recipient ||
        from.status !== 'active' || to.status !== 'active'
      ) {
        throw Object.assign(
          new Error('A customer or account is unavailable or frozen.'),
          { status: 400 }
        );
      }

      if (from.balanceCents < review.amountCents) {
        throw Object.assign(
          new Error('The sender no longer has enough balance.'),
          { status: 400 }
        );
      }

      const accountIds = await Account.find({ userId: sender._id })
        .distinct('_id')
        .session(dbSession);

      const dayStart = new Date();
      dayStart.setUTCHours(0, 0, 0, 0);

      const totals = await LedgerEntry.aggregate([
        {
          $match: {
            accountId: { $in: accountIds },
            kind: 'transfer_out',
            createdAt: { $gte: dayStart }
          }
        },
        { $group: { _id: null, total: { $sum: '$amountCents' } } }
      ]).session(dbSession);

      const limit = sender.dailyTransferLimitCents || 100000;

      if ((totals[0]?.total || 0) + review.amountCents > limit) {
        throw Object.assign(
          new Error('Approving this request would exceed the customer daily limit.'),
          { status: 400 }
        );
      }

      senderName = sender.name;
      recipientName = recipient.name;
      recipientId = recipient._id;

      from.balanceCents -= review.amountCents;
      to.balanceCents += review.amountCents;

      await from.save({ session: dbSession });
      await to.save({ session: dbSession });

      const transferGroup = crypto.randomUUID();

      await LedgerEntry.create([
        {
          transferGroup,
          accountId: from._id,
          counterpartyAccountId: to._id,
          counterpartyName: recipient.name,
          kind: 'transfer_out',
          amountCents: review.amountCents,
          balanceAfterCents: from.balanceCents,
          description: review.memo,
          category: review.category
        },
        {
          transferGroup,
          accountId: to._id,
          counterpartyAccountId: from._id,
          counterpartyName: sender.name,
          kind: 'transfer_in',
          amountCents: review.amountCents,
          balanceAfterCents: to.balanceCents,
          description: review.memo,
          category: review.category
        }
      ], { session: dbSession, ordered: true });

      review.status = 'approved';
      review.reviewReason = req.auditReason;
      review.reviewedBy = req.session.user.id;
      review.reviewedAt = new Date();

      await review.save({ session: dbSession });

      await notify(
        sender._id,
        'Transfer approved',
        `$${money(review.amountCents)} sent to ${recipient.name}.`,
        dbSession
      );

      await notify(
        recipient._id,
        'Transfer received',
        `$${money(review.amountCents)} received from ${sender.name}.`,
        dbSession
      );
    });
  } catch (error) {
    await TransferReview.updateOne(
      { _id: review._id, status: 'processing' },
      { $set: { status: 'pending' } }
    );

    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }

    throw error;
  } finally {
    await dbSession.endSession();
  }

  await Promise.all([
    sendTransactionAlert(
      review.userId,
      'Transfer approved',
      `$${money(review.amountCents)} sent to ${recipientName}.`
    ),
    sendTransactionAlert(
      recipientId,
      'Transfer received',
      `$${money(review.amountCents)} received from ${senderName}.`
    )
  ]);

  await recordAdminAction(req, 'approve_transfer_review', review._id, {
    amount: money(review.amountCents)
  });

  res.json({ message: 'Transfer approved and completed.' });
}

async function emailCustomers(req, res) {
  const subject = String(req.body.subject || '').trim().slice(0, 120);
  const message = String(req.body.message || '').trim().slice(0, 5000);

  if (subject.length < 3 || message.length < 3) {
    return res.status(400).json({ error: 'Add a subject and message.' });
  }

  if (!mailer) {
    return res.status(503).json({
      error: 'Configure SMTP before sending customer email.'
    });
  }

  const smtp = await checkMailer();
  if (!smtp.ready) {
    return res.status(503).json({ error: smtp.reason });
  }

  const recipients = await User.find({
    role: 'customer',
    verified: true,
    emailOptIn: true
  }).select('email').sort({ createdAt: 1 }).limit(500).lean();

  const safeSubject = subject.replace(/[\r\n]/g, ' ');
  const escapedMessage = escapeHtml(message).replace(/\n/g, '<br>');
  const recipientResults = [];

  for (const recipient of recipients) {
    try {
      const info = await sendMail({
        to: recipient.email,
        subject: `[Harborline] ${safeSubject}`,
        text: `${message}\n\nHarborline.`,
        html: `<p>${escapedMessage}</p><hr><small>Harborline</small>`
      });

      if (info?.rejected?.length) {
        throw new Error('SMTP rejected the recipient address.');
      }

      recipientResults.push({ email: recipient.email, status: 'sent' });
    } catch (error) {
      console.error('Customer email delivery failed:', error.message);
      recipientResults.push({ email: recipient.email, status: 'failed' });
    }
  }

  const deliveredCount = recipientResults.filter(item => item.status === 'sent').length;
  const failedCount = recipientResults.length - deliveredCount;
  const deliveryStatus = failedCount === 0
    ? 'sent'
    : deliveredCount
      ? 'partial'
      : 'failed';

  await MailLog.create({
    adminId: req.session.user.id,
    subject: safeSubject,
    recipientCount: recipients.length,
    deliveredCount,
    failedCount,
    deliveryStatus,
    recipientResults
  });

  await recordAdminAction(req, 'email_customers', '', {
    subject: safeSubject,
    recipientCount: recipients.length,
    deliveredCount,
    failedCount
  });

  res.json({
    message: `Email delivery finished: ${deliveredCount} sent, ${failedCount} failed.`,
    deliveryStatus,
    deliveredCount,
    failedCount
  });
}

async function emailStatus(req, res) {
  const result = await checkMailer();

  res.json({
    ...result,
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 587),
    checkedAt: new Date()
  });
}

async function emailHistory(req, res) {
  const messages = await MailLog.find()
    .sort({ createdAt: -1 })
    .limit(100)
    .populate('adminId', 'name email')
    .lean();

  res.json({
    messages: messages.map(message => ({
      id: String(message._id),
      subject: message.subject,
      kind: message.kind || 'general',
      recipientCount: message.recipientCount,
      deliveredCount: message.deliveredCount ?? message.recipientCount,
      failedCount: message.failedCount || 0,
      deliveryStatus: message.deliveryStatus || 'sent',
      recipientResults: message.recipientResults || [],
      createdAt: message.createdAt,
      admin: message.adminId?.email
    }))
  });
}

async function auditHistory(req, res) {
  const entries = await AuditLog.find()
    .sort({ createdAt: -1 })
    .limit(150)
    .populate('adminId', 'name email')
    .lean();

  res.json({
    entries: entries.map(entry => ({
      id: String(entry._id),
      action: entry.action,
      targetId: entry.targetId,
      details: entry.details,
      ip: entry.ip,
      createdAt: entry.createdAt,
      admin: entry.adminId?.email
    }))
  });
}

module.exports = {
  listAccounts,
  fundAccount,
  createAccount,
  setAccountNumber,
  setAccountStatus,
  accountActivity,
  downloadAccountStatement,
  setAdminRole,
  createAdmin,
  setTransferLimit,
  setTransferReviewThreshold,
  listTransferReviews,
  resolveTransferReview,
  emailCustomers,
  emailStatus,
  emailHistory,
  auditHistory
};
