// controllers/adminController.js
const crypto = require('crypto');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const User = require('../models/User');
const Account = require('../models/Account');
const LedgerEntry = require('../models/LedgerEntry');
const MailLog = require('../models/MailLog');
const AuditLog = require('../models/AuditLog');
const TransferReview = require('../models/TransferReview');

const { cents, money, fmtMoney } = require('../utils/finance');
const { escapeHtml, isStrongPassword } = require('../utils/identity');

const { sendMail, mailer, checkMailer } = require('../services/emailService');
const { createAccountNumber } = require('../config/database');
const { recordAdminAction } = require('../services/auditService');
const { notify } = require('../services/notificationService');
const { sendTransactionAlert } = require('../services/emailAlertService');
const { statementHtml } = require('../services/statementService');
const { mapLimit } = require('../utils/async');
const { renderEmail } = require('../services/emailTemplates');
const { sendFundingReceipt, queueEntryAlert } = require('../services/fundingReceiptService');

const { DEFAULT_DAILY_LIMIT_CENTS: DEFAULT_DAILY_TRANSFER_LIMIT_CENTS } = require('../utils/finance');

function safeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function httpError(message, status) {
  return Object.assign(new Error(message), { status });
}

function validObjectId(value) {
  return mongoose.isValidObjectId(value);
}

async function sendSafely(task, label) {
  try {
    await task();
  } catch (error) {
    console.error(`${label} failed:`, error.message);
  }
}

async function listAccounts(req, res) {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 25));
  const search = String(req.query.search || '').trim().slice(0, 80);
  const escapedSearch = safeRegex(search);

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

  const userIds = users.map(user => user._id);

  const accounts = userIds.length
    ? await Account.find({ userId: { $in: userIds } }).lean()
    : [];

  const accountIds = accounts.map(account => account._id);

  const counts = accountIds.length
    ? await LedgerEntry.aggregate([
        { $match: { accountId: { $in: accountIds } } },
        { $group: { _id: '$accountId', count: { $sum: 1 } } }
      ])
    : [];

  const countMap = new Map(
    counts.map(item => [String(item._id), item.count])
  );

  const accountsByUser = new Map();

  for (const account of accounts) {
    const key = String(account.userId);
    if (!accountsByUser.has(key)) accountsByUser.set(key, []);
    accountsByUser.get(key).push(account);
  }

  const rows = users.flatMap(user => {
    const userAccounts = accountsByUser.get(String(user._id)) || [];

    if (!userAccounts.length) {
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

    return userAccounts.map(account => ({
      id: String(user._id),
      name: user.name,
      email: user.email,
      verified: user.verified,
      created_at: user.createdAt,
      accountId: String(account._id),
      account_number: account.accountNumber,
      accountType: account.accountType,
      nickname: account.nickname,
      status: account.status,
      balance: money(account.balanceCents),
      currency: account.currency,
      transaction_count: countMap.get(String(account._id)) || 0,
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
  const memo = String(
    req.body.memo || 'Funds added by administrator'
  ).trim().slice(0, 100) || 'Funds added by administrator';

  if (!email && !accountNumber) {
    return res.status(400).json({
      error: 'Provide a customer email or account number.'
    });
  }

  if (!amount || amount <= 0 || amount > 100000000) {
    return res.status(400).json({
      error: 'Enter a valid amount up to $1,000,000.'
    });
  }

  const dbSession = await mongoose.startSession();

  let fundedUser;
  let fundedAccount;
  let balanceAfter;
  let ledgerEntryId;
  let ledgerReference;

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
        throw httpError('Customer account not found.', 404);
      }

      if (account.status !== 'active') {
        throw httpError('This account is frozen or inactive.', 400);
      }

      const owner = await User.findOne({
        _id: account.userId,
        role: 'customer'
      }).session(dbSession);

      if (!owner) {
        throw httpError('Customer account not found.', 404);
      }

      if (email && String(owner.email).toLowerCase() !== email) {
        throw httpError(
          'The account number does not belong to the supplied customer email.',
          400
        );
      }

      fundedUser = {
        id: String(owner._id),
        name: owner.name,
        email: owner.email
      };

      fundedAccount = {
        id: String(account._id),
        accountNumber: account.accountNumber,
        accountType: account.accountType,
        nickname: account.nickname,
        currency: account.currency
      };

      account.balanceCents += amount;
      balanceAfter = account.balanceCents;

      await account.save({ session: dbSession });

      const transferGroup = crypto.randomUUID();

      const [entry] = await LedgerEntry.create([{
        transferGroup,
        accountId: account._id,
        kind: 'funding',
        amountCents: amount,
        balanceAfterCents: balanceAfter,
        description: memo,
        category: 'Transfer'
      }], {
        session: dbSession,
        ordered: true
      });

      ledgerEntryId = String(entry._id);
      ledgerReference = transferGroup;

      await notify(
        owner._id,
        'Funds added',
        `$${fmtMoney(amount)} added to ${account.nickname || account.accountType}.`,
        dbSession
      );
    });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }
    throw error;
  } finally {
    await dbSession.endSession();
  }

  // Email and receipt generation happen after the database transaction commits.
  // Email failure must not undo a successful account funding.
  // One combined "credit alert" email carries the message, a PDF receipt attachment and a receipt link.
  // It is sent in the background so a slow email service can never delay (or time out) the funding response,
  // which could otherwise tempt an administrator to fund the same account twice.
  sendSafely(
    () => sendFundingReceipt({
      user: fundedUser,
      account: fundedAccount,
      amountCents: amount,
      balanceAfterCents: balanceAfter,
      description: memo,
      transactionId: ledgerEntryId,
      reference: ledgerReference,
      transactionDate: new Date()
    }),
    'Funding credit alert email'
  );

  await sendSafely(
    () => recordAdminAction(
      req,
      'fund_account',
      fundedAccount.id,
      {
        amount: money(amount),
        memo,
        transactionId: ledgerEntryId
      }
    ),
    'Funding audit log'
  );

  res.json({
    message: `Added $${fmtMoney(amount)}.`,
    balance: money(balanceAfter),
    transactionId: ledgerEntryId
  });
}

async function createAccount(req, res) {
  const email = String(req.body.email || '').trim().toLowerCase();
  const accountType = req.body.accountType === 'savings' ? 'savings' : 'checking';

  const nickname = String(
    req.body.nickname ||
    (accountType === 'savings' ? 'Savings' : 'Everyday Checking')
  ).trim().slice(0, 40);

  const user = await User.findOne({ email, role: 'customer' });

  if (!user) {
    return res.status(404).json({ error: 'Customer not found.' });
  }

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
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        error: 'That account type already exists for this customer.'
      });
    }
    throw error;
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

    if (!account) {
      return res.status(404).json({ error: 'Account not found.' });
    }

    await recordAdminAction(req, 'change_account_number', account._id, {
      accountNumber
    });

    res.json({ message: 'Account number updated.', accountNumber });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        error: 'That account number is already in use.'
      });
    }
    throw error;
  }
}

async function setAccountStatus(req, res) {
  const status = req.body.status;

  if (!['active', 'frozen'].includes(status)) {
    return res.status(400).json({ error: 'Choose active or frozen.' });
  }

  const account = await Account.findById(req.params.id);

  if (
    !account ||
    !await User.exists({ _id: account.userId, role: 'customer' })
  ) {
    return res.status(404).json({ error: 'Account not found.' });
  }

  account.status = status;
  await account.save();

  await recordAdminAction(req, 'set_account_status', account._id, { status });

  await sendSafely(
    () => notify(
      account.userId,
      `Account ${status}`,
      `Your ${account.nickname || account.accountType} account is ${status}.`
    ),
    'Account status notification'
  );

  res.json({ message: `Account ${status}.`, status });
}

async function accountActivity(req, res) {
  const account = await Account.findById(req.params.id)
    .populate('userId', 'name email');

  if (!account) {
    return res.status(404).json({ error: 'Account not found.' });
  }

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
    : new Date(Date.UTC(
        new Date().getUTCFullYear(),
        new Date().getUTCMonth(),
        1
      ));

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

  if (!account) {
    return res.status(404).json({ error: 'Account not found.' });
  }

  const [owner, entries] = await Promise.all([
    User.findById(account.userId).select('name email').lean(),
    LedgerEntry.find({
      accountId: account._id,
      createdAt: { $gte: start, $lte: end }
    }).sort({ createdAt: 1 }).limit(5000).lean()
  ]);

  res.type('html')
    .set(
      'Content-Disposition',
      'attachment; filename="harborline-statement.html"'
    )
    .send(statementHtml({ owner, account, entries, start, end }));
}

async function setAdminRole(req, res) {
  const adminRole = String(req.body.adminRole || '');

  if (!['owner', 'operations', 'auditor'].includes(adminRole)) {
    return res.status(400).json({
      error: 'Choose owner, operations, or auditor.'
    });
  }

  if (
    String(req.params.id) === String(req.session.user.id) &&
    adminRole !== 'owner'
  ) {
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
    { new: true }
  );

  if (!user) {
    return res.status(404).json({ error: 'Administrator not found.' });
  }

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
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    !isStrongPassword(password, 16) ||
    !['operations', 'auditor'].includes(adminRole)
  ) {
    return res.status(400).json({
      error: 'Enter a name, valid email, 16+ character strong password, and operations or auditor role.'
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

    await recordAdminAction(req, 'create_admin', user._id, {
      email,
      adminRole
    });

    res.status(201).json({
      message: 'Administrator created. Sign-in requires email verification code.'
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        error: 'An account already uses that email.'
      });
    }
    throw error;
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
    { new: true }
  );

  if (!user) {
    return res.status(404).json({ error: 'Customer not found.' });
  }

  await recordAdminAction(req, 'set_transfer_limit', user._id, {
    dailyLimit: money(limit)
  });

  res.json({
    message: 'Daily transfer limit updated.',
    amount: money(limit)
  });
}

async function setTransferReviewThreshold(req, res) {
  const raw = String(req.body.amount ?? '').trim();
  const threshold = raw === '0' || raw === '0.00' ? 0 : cents(raw);

  if (threshold === null || threshold < 0 || threshold > 100000000) {
    return res.status(400).json({
      error: 'Enter 0 to disable review, or an amount up to $1,000,000.'
    });
  }

  const user = await User.findOneAndUpdate(
    { _id: req.params.id, role: 'customer' },
    { transferReviewThresholdCents: threshold },
    { new: true }
  );

  if (!user) {
    return res.status(404).json({ error: 'Customer not found.' });
  }

  await recordAdminAction(req, 'set_transfer_review_threshold', user._id, {
    threshold: money(threshold)
  });

  res.json({
    message: threshold
      ? `Transfers of $${fmtMoney(threshold)} or more will require review.`
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
    return res.status(404).json({
      error: 'Pending transfer review not found.'
    });
  }

  if (decision === 'reject') {
    review.status = 'rejected';
    review.reviewReason = req.auditReason;
    review.reviewedBy = req.session.user.id;
    review.reviewedAt = new Date();
    await review.save();

    await sendSafely(
      () => notify(
        review.userId,
        'Transfer not approved',
        'Your transfer request was not approved. Contact support if you need more information.'
      ),
      'Transfer rejection notification'
    );

    await recordAdminAction(req, 'reject_transfer_review', review._id, {
      amount: money(review.amountCents)
    });

    return res.json({ message: 'Transfer request rejected.' });
  }

  const dbSession = await mongoose.startSession();

  let outEntryId;
  let inEntryId;

  try {
    await dbSession.withTransaction(async () => {
      const locked = await Account.find({
        _id: { $in: [review.fromAccountId, review.toAccountId] }
      }).sort({ _id: 1 }).session(dbSession);

      const byId = new Map(
        locked.map(account => [String(account._id), account])
      );

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
        throw httpError('A customer or account is unavailable or frozen.', 400);
      }

      if (from.balanceCents < review.amountCents) {
        throw httpError('The sender no longer has enough balance.', 400);
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

      const limit = sender.dailyTransferLimitCents || DEFAULT_DAILY_TRANSFER_LIMIT_CENTS;

      if ((totals[0]?.total || 0) + review.amountCents > limit) {
        throw httpError(
          'Approving this request would exceed the customer daily limit.',
          400
        );
      }

      from.balanceCents -= review.amountCents;
      to.balanceCents += review.amountCents;

      await from.save({ session: dbSession });
      await to.save({ session: dbSession });

      const transferGroup = crypto.randomUUID();

      const created = await LedgerEntry.create([
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
      ], {
        session: dbSession,
        ordered: true
      });

      outEntryId = created[0]._id;
      inEntryId = created[1]._id;

      review.status = 'approved';
      review.reviewReason = req.auditReason;
      review.reviewedBy = req.session.user.id;
      review.reviewedAt = new Date();

      await review.save({ session: dbSession });

      await notify(
        sender._id,
        'Transfer approved',
        `$${fmtMoney(review.amountCents)} sent to ${recipient.name}.`,
        dbSession
      );

      await notify(
        recipient._id,
        'Transfer received',
        `$${fmtMoney(review.amountCents)} received from ${sender.name}.`,
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

  queueEntryAlert(outEntryId);
  queueEntryAlert(inEntryId);

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
      error: 'Configure email delivery before sending customer email.'
    });
  }

  const mailStatus = await checkMailer();

  if (!mailStatus.ready) {
    return res.status(503).json({ error: mailStatus.reason });
  }

  const recipients = await User.find({
    role: 'customer',
    verified: true,
    emailOptIn: true
  })
    .select('email')
    .sort({ createdAt: 1 })
    .limit(500)
    .lean();

  const safeSubject = subject.replace(/[\r\n]/g, ' ');
  const escapedMessage = escapeHtml(message).replace(/\n/g, '<br>');

  const recipientResults = await mapLimit(recipients, 8, async recipient => {
    try {
      const info = await sendMail({
        to: recipient.email,
        subject: `[Harborline] ${safeSubject}`,
        text: `${message}\n\nHarborline`,
        html: renderEmail({ title: safeSubject, intro: message })
      });

      if (info?.rejected?.length) {
        throw new Error('Email provider rejected the recipient.');
      }

      return { email: recipient.email, status: 'sent' };
    } catch (error) {
      return { email: recipient.email, status: 'failed', error: error.message };
    }
  });

  const deliveredCount = recipientResults.filter(
    item => item.status === 'sent'
  ).length;

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
    provider: 'Brevo',
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