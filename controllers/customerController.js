
const crypto = require('crypto');
const mongoose = require('mongoose');

const User = require('../models/User');
const Account = require('../models/Account');
const LedgerEntry = require('../models/LedgerEntry');
const DeviceSession = require('../models/DeviceSession');
const Notification = require('../models/Notification');
const CardTransaction = require('../models/CardTransaction');
const Card = require('../models/Card');
const ScheduledTransfer = require('../models/ScheduledTransfer');
const TransferReview = require('../models/TransferReview');

const { notify } = require('../services/notificationService');
const { sendTransactionAlert } = require('../services/emailAlertService');
const { cents, money } = require('../utils/finance');
const { safeUser } = require('../utils/identity');
const { statementHtml } = require('../services/statementService');
const { processDueTransfers } = require('../services/scheduledTransferService');

const TRANSFER_CATEGORIES = [
  'Transfer',
  'Food & drink',
  'Home & bills',
  'Shopping',
  'Transport',
  'Health',
  'Other'
];

const MAX_TRANSFER_CENTS = 100000000;
const MAX_STATEMENT_DAYS = 366;

function getUserId(req) {
  return req.session.user.id;
}

function createHttpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function sendError(res, error) {
  if (error.status) {
    return res.status(error.status).json({ error: error.message });
  }

  throw error;
}

function parsePositiveCents(value) {
  const amount = cents(value);

  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return null;
  }

  return amount;
}

function normalizeAccountNumber(value) {
  return String(value || '').replace(/\s/g, '');
}

function normalizeMemo(value, fallback = 'Personal transfer') {
  return String(value || fallback).trim().slice(0, 100) || fallback;
}

function normalizeCategory(value) {
  return TRANSFER_CATEGORIES.includes(value) ? value : 'Transfer';
}

function isValidDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function dateRange(query) {
  const now = new Date();

  const startString = query.start;
  const endString = query.end;

  if (startString && !isValidDateOnly(startString)) return null;
  if (endString && !isValidDateOnly(endString)) return null;

  const start = startString
    ? new Date(`${startString}T00:00:00.000Z`)
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const end = endString
    ? new Date(`${endString}T23:59:59.999Z`)
    : now;

  if (
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    start > end ||
    end.getTime() - start.getTime() > MAX_STATEMENT_DAYS * 86400000
  ) {
    return null;
  }

  return { start, end };
}

async function sendAlertSafely(userId, subject, message) {
  try {
    await sendTransactionAlert(userId, subject, message);
  } catch (error) {
    console.error('Transaction email alert failed:', error.message);
  }
}

async function downloadStatement(req, res) {
  const range = dateRange(req.query);

  if (!range) {
    return res.status(400).json({
      error: 'Choose a valid statement period of no more than 12 months.'
    });
  }

  const account = await Account.findOne({
    _id: req.query.accountId,
    userId: getUserId(req)
  }).lean();

  if (!account) {
    return res.status(404).json({ error: 'Account not found.' });
  }

  const [owner, entries] = await Promise.all([
    User.findById(getUserId(req))
      .select('name email')
      .lean(),

    LedgerEntry.find({
      accountId: account._id,
      createdAt: {
        $gte: range.start,
        $lte: range.end
      }
    })
      .sort({ createdAt: 1 })
      .limit(5000)
      .lean()
  ]);

  return res
    .type('html')
    .set(
      'Content-Disposition',
      'attachment; filename="harborline-portfolio-statement.html"'
    )
    .send(statementHtml({
      owner,
      account,
      entries,
      ...range
    }));
}

async function currentUser(req, res) {
  if (!req.session.user) {
    return res.json({ user: null });
  }

  const user = await User.findById(getUserId(req));

  if (!user) {
    req.session.destroy(() => {});
    return res.json({ user: null });
  }

  if (!user.verified || user.role === 'admin') {
    return res.json({
      user: safeUser(user),
      account: null,
      transactions: []
    });
  }

  const accounts = await Account.find({ userId: user._id })
    .sort({ accountType: 1, createdAt: 1 })
    .lean();

  const account =
    accounts.find(item => item.accountType === 'checking') ||
    accounts[0];

  if (!account) {
    return res.status(500).json({
      error: 'Account is unavailable.'
    });
  }

  const accountIds = accounts.map(item => item._id);

  const [
    entries,
    creditPurchases,
    creditCardIds,
    ledgerTotal,
    creditTotal,
    notifications
  ] = await Promise.all([
    LedgerEntry.find({
      accountId: { $in: accountIds }
    })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean(),

    CardTransaction.find({
      userId: user._id,
      kind: 'purchase'
    })
      .populate('cardId', 'cardType')
      .sort({ createdAt: -1 })
      .limit(50)
      .lean(),

    Card.find({
      userId: user._id,
      cardType: 'credit'
    }).distinct('_id'),

    LedgerEntry.countDocuments({
      accountId: { $in: accountIds }
    }),

    CardTransaction.countDocuments({
      userId: user._id,
      kind: 'purchase'
    }),

    Notification.find({ userId: user._id })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean()
  ]);

  const transactions = [
    ...entries.map(entry => ({
      ...entry,
      counterparty_name: entry.counterpartyName || null,
      amount: money(entry.amountCents),
      balanceAfter: money(entry.balanceAfterCents)
    })),

    ...creditPurchases
      .filter(item => item.cardId?.cardType === 'credit')
      .map(item => ({
        _id: item._id,
        transferGroup: `card-${item._id}`,
        kind: 'card_purchase',
        category: item.category,
        description: item.description,
        amount: money(item.amountCents),
        balanceAfter: '',
        createdAt: item.createdAt,
        counterparty_name: null
      }))
  ]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 100);

  return res.json({
    user: safeUser(user),

    account: {
      id: String(account._id),
      accountNumber: account.accountNumber,
      balance: money(account.balanceCents),
      currency: account.currency,
      status: account.status
    },

    accounts: accounts.map(item => ({
      id: String(item._id),
      accountNumber: item.accountNumber,
      accountType: item.accountType,
      nickname: item.nickname || '',
      status: item.status,
      balance: money(item.balanceCents),
      currency: item.currency
    })),

    dailyTransferLimit: money(user.dailyTransferLimitCents || 100000),

    transactionsHasMore: ledgerTotal + creditTotal > 100,

    notifications: notifications.map(item => ({
      id: String(item._id),
      title: item.title,
      message: item.message,
      read: Boolean(item.readAt),
      createdAt: item.createdAt
    })),

    transactions
  });
}

async function listTransactions(req, res) {
  const parsedOffset = Number.parseInt(req.query.offset, 10);
  const parsedLimit = Number.parseInt(req.query.limit, 10);

  const offset = Math.max(
    0,
    Math.min(5000, Number.isFinite(parsedOffset) ? parsedOffset : 0)
  );

  const limit = Math.min(
    100,
    Math.max(1, Number.isFinite(parsedLimit) ? parsedLimit : 100)
  );

  const accounts = await Account.find({
    userId: getUserId(req)
  })
    .select('_id')
    .lean();

  const accountIds = accounts.map(item => item._id);

  const creditCardIds = await Card.find({
    userId: getUserId(req),
    cardType: 'credit'
  }).distinct('_id');

  const [
    entries,
    purchases,
    ledgerTotal,
    purchaseTotal
  ] = await Promise.all([
    LedgerEntry.find({
      accountId: { $in: accountIds }
    })
      .sort({ createdAt: -1 })
      .limit(offset + limit)
      .lean(),

    CardTransaction.find({
      userId: getUserId(req),
      cardId: { $in: creditCardIds },
      kind: 'purchase'
    })
      .populate('cardId', 'cardType')
      .sort({ createdAt: -1 })
      .limit(offset + limit)
      .lean(),

    LedgerEntry.countDocuments({
      accountId: { $in: accountIds }
    }),

    CardTransaction.countDocuments({
      userId: getUserId(req),
      cardId: { $in: creditCardIds },
      kind: 'purchase'
    })
  ]);

  const rows = [
    ...entries.map(item => ({
      ...item,
      counterparty_name: item.counterpartyName || null,
      amount: money(item.amountCents),
      balanceAfter: money(item.balanceAfterCents)
    })),

    ...purchases
      .filter(item => item.cardId?.cardType === 'credit')
      .map(item => ({
        _id: item._id,
        transferGroup: `card-${item._id}`,
        kind: 'card_purchase',
        category: item.category,
        description: item.description,
        amount: money(item.amountCents),
        balanceAfter: '',
        createdAt: item.createdAt,
        counterparty_name: null
      }))
  ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const total = ledgerTotal + purchaseTotal;

  return res.json({
    transactions: rows.slice(offset, offset + limit),
    offset,
    total,
    hasMore: total > offset + limit
  });
}

async function updatePreferences(req, res) {
  const update = {};

  if (typeof req.body.emailOptIn === 'boolean') {
    update.emailOptIn = req.body.emailOptIn;
  }

  if (typeof req.body.transactionAlerts === 'boolean') {
    update.transactionAlerts = req.body.transactionAlerts;
  }

  if (!Object.keys(update).length) {
    return res.status(400).json({
      error: 'Choose an email preference.'
    });
  }

  const user = await User.findByIdAndUpdate(
    getUserId(req),
    update,
    {
      new: true,
      runValidators: true
    }
  );

  if (!user) {
    return res.status(404).json({ error: 'User not found.' });
  }

  return res.json({
    user: safeUser(user),
    message: 'Email preferences saved.'
  });
}

async function transfer(req, res) {
  if (req.body.scheduledAt) {
    return scheduleTransfer(req, res);
  }

  const userId = getUserId(req);
  const recipientNumber = normalizeAccountNumber(req.body.accountNumber);
  const amount = parsePositiveCents(req.body.amount);
  const memo = normalizeMemo(req.body.memo);
  const category = normalizeCategory(req.body.category);

  if (
    !/^\d{10}$/.test(recipientNumber) ||
    !amount ||
    amount > MAX_TRANSFER_CENTS
  ) {
    return res.status(400).json({
      error: 'Enter a valid 10-digit recipient account and amount up to $1,000,000.'
    });
  }

  const dbSession = await mongoose.startSession();

  let newBalance;
  let recipientName;
  let recipientId;
  let reviewPending = false;

  try {
    await dbSession.withTransaction(async () => {
      const sender = await Account.findOne(
        req.body.fromAccountId
          ? {
              _id: req.body.fromAccountId,
              userId
            }
          : {
              userId,
              accountType: 'checking'
            }
      ).session(dbSession);

      const recipient = await Account.findOne({
        accountNumber: recipientNumber
      }).session(dbSession);

      if (
        !sender ||
        !recipient ||
        String(recipient._id) === String(sender._id)
      ) {
        throw createHttpError('Recipient account was not found.');
      }

      const recipientUser = await User.findOne({
        _id: recipient.userId,
        verified: true
      }).session(dbSession);

      if (!recipientUser) {
        throw createHttpError('Recipient account was not found.');
      }

      if (sender.status !== 'active' || recipient.status !== 'active') {
        throw createHttpError('One of these accounts is frozen.');
      }

      // Reload both accounts in a consistent order within the transaction.
      const lockedAccounts = await Account.find({
        _id: { $in: [sender._id, recipient._id] }
      })
        .sort({ _id: 1 })
        .session(dbSession);

      const byId = new Map(
        lockedAccounts.map(account => [String(account._id), account])
      );

      const from = byId.get(String(sender._id));
      const to = byId.get(String(recipient._id));

      if (!from || !to) {
        throw createHttpError('Account is unavailable.');
      }

      if (from.status !== 'active' || to.status !== 'active') {
        throw createHttpError('One of these accounts is frozen.');
      }

      if (from.balanceCents < amount) {
        throw createHttpError('Insufficient demo funds for this transfer.');
      }

      const user = await User.findById(userId).session(dbSession);

      if (!user) {
        throw createHttpError('User account was not found.', 404);
      }

      const dailyLimit = user.dailyTransferLimitCents || 100000;

      const accountIds = await Account.find({
        userId: user._id
      })
        .distinct('_id')
        .session(dbSession);

      const startOfDay = new Date();
      startOfDay.setUTCHours(0, 0, 0, 0);

      const totals = await LedgerEntry.aggregate([
        {
          $match: {
            accountId: { $in: accountIds },
            kind: 'transfer_out',
            createdAt: { $gte: startOfDay }
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: '$amountCents' }
          }
        }
      ]).session(dbSession);

      if ((totals[0]?.total || 0) + amount > dailyLimit) {
        throw createHttpError(
          `This transfer exceeds your daily limit of $${money(dailyLimit)}.`
        );
      }

      if (
        user.transferReviewThresholdCents > 0 &&
        amount >= user.transferReviewThresholdCents
      ) {
        await TransferReview.create(
          [
            {
              userId: user._id,
              fromAccountId: from._id,
              toAccountId: to._id,
              amountCents: amount,
              memo,
              category,
              status: 'pending'
            }
          ],
          { session: dbSession, ordered: true }
        );

        await notify(
          user._id,
          'Transfer awaiting review',
          `Your $${money(amount)} transfer is awaiting administrator review.`,
          dbSession
        );

        reviewPending = true;
        return;
      }

      const senderUser = await User.findById(from.userId).session(dbSession);

      from.balanceCents -= amount;
      to.balanceCents += amount;

      newBalance = from.balanceCents;
      recipientName = recipientUser.name;
      recipientId = recipientUser._id;

      await from.save({ session: dbSession });
      await to.save({ session: dbSession });

      const transferGroup = crypto.randomUUID();

      await LedgerEntry.create(
        [
          {
            transferGroup,
            accountId: from._id,
            counterpartyAccountId: to._id,
            counterpartyName: recipientUser.name,
            kind: 'transfer_out',
            amountCents: amount,
            balanceAfterCents: from.balanceCents,
            description: memo,
            category
          },
          {
            transferGroup,
            accountId: to._id,
            counterpartyAccountId: from._id,
            counterpartyName: senderUser?.name || 'Harborline customer',
            kind: 'transfer_in',
            amountCents: amount,
            balanceAfterCents: to.balanceCents,
            description: memo,
            category
          }
        ],
        { session: dbSession, ordered: true }
      );

      await notify(
        user._id,
        'Transfer sent',
        `$${money(amount)} sent to ${recipientUser.name}.`,
        dbSession
      );

      await notify(
        recipientUser._id,
        'Transfer received',
        `$${money(amount)} received from ${senderUser?.name || 'a Harborline customer'}.`,
        dbSession
      );
    });
  } catch (error) {
    return sendError(res, error);
  } finally {
    await dbSession.endSession();
  }

  if (reviewPending) {
    return res.status(202).json({
      message: 'Transfer submitted for administrator review. The balance has not changed yet.',
      status: 'pending_review'
    });
  }

  await Promise.all([
    sendAlertSafely(
      userId,
      'Transfer sent',
      `$${money(amount)} sent to ${recipientName}.`
    ),

    sendAlertSafely(
      recipientId,
      'Transfer received',
      `$${money(amount)} received from a Harborline customer.`
    )
  ]);

  return res.json({
    message: 'Transfer completed.',
    balance: money(newBalance),
    recipient: recipientName
  });
}

async function scheduleTransfer(req, res) {
  const userId = getUserId(req);
  const recipientNumber = normalizeAccountNumber(req.body.accountNumber);
  const amount = parsePositiveCents(req.body.amount);
  const scheduledAt = new Date(req.body.scheduledAt);
  const memo = normalizeMemo(
    req.body.memo,
    'Scheduled personal transfer'
  );
  const category = normalizeCategory(req.body.category);

  if (
    !/^\d{10}$/.test(recipientNumber) ||
    !amount ||
    amount > MAX_TRANSFER_CENTS ||
    Number.isNaN(scheduledAt.getTime()) ||
    scheduledAt.getTime() < Date.now() + 5 * 60 * 1000 ||
    scheduledAt.getTime() > Date.now() + 366 * 86400000
  ) {
    return res.status(400).json({
      error: 'Choose a valid recipient, amount, and date at least 5 minutes from now and within one year.'
    });
  }

  const [from, to] = await Promise.all([
    Account.findOne({
      _id: req.body.fromAccountId,
      userId,
      status: 'active'
    }),

    Account.findOne({
      accountNumber: recipientNumber,
      status: 'active'
    })
  ]);

  if (
    !from ||
    !to ||
    String(from._id) === String(to._id)
  ) {
    return res.status(400).json({
      error: 'Choose active accounts belonging to different customers.'
    });
  }

  const recipient = await User.findOne({
    _id: to.userId,
    role: 'customer',
    verified: true
  });

  if (!recipient) {
    return res.status(400).json({
      error: 'Recipient account was not found.'
    });
  }

  const sender = await User.findById(userId)
    .select('transferReviewThresholdCents');

  if (
    sender?.transferReviewThresholdCents > 0 &&
    amount >= sender.transferReviewThresholdCents
  ) {
    return res.status(409).json({
      error: 'This amount requires administrator review. Submit it as an immediate transfer to send it for review.'
    });
  }

  const transfer = await ScheduledTransfer.create({
    userId,
    fromAccountId: from._id,
    toAccountId: to._id,
    amountCents: amount,
    memo,
    category,
    scheduledAt
  });

  return res.status(201).json({
    message: `Transfer scheduled for ${scheduledAt.toLocaleString()}.`,
    transfer: {
      id: String(transfer._id),
      scheduledAt,
      amount: money(amount),
      status: transfer.status
    }
  });
}

async function listScheduledTransfers(req, res) {
  await processDueTransfers();

  const transfers = await ScheduledTransfer.find({
    userId: getUserId(req)
  })
    .sort({ scheduledAt: -1 })
    .limit(100)
    .populate('toAccountId', 'accountNumber nickname')
    .lean();

  return res.json({
    transfers: transfers.map(item => ({
      id: String(item._id),
      scheduledAt: item.scheduledAt,
      amount: money(item.amountCents),
      status: item.status,
      failureReason: item.failureReason || '',
      memo: item.memo,
      recipient:
        item.toAccountId?.nickname ||
        `•••• ${item.toAccountId?.accountNumber?.slice(-4) || ''}`
    }))
  });
}

async function cancelScheduledTransfer(req, res) {
  const item = await ScheduledTransfer.findOneAndUpdate(
    {
      _id: req.params.id,
      userId: getUserId(req),
      status: 'scheduled',
      scheduledAt: { $gt: new Date() }
    },
    { status: 'canceled' },
    { new: true }
  );

  if (!item) {
    return res.status(404).json({
      error: 'Upcoming scheduled transfer not found.'
    });
  }

  return res.json({
    message: 'Scheduled transfer canceled.'
  });
}

async function listTransferReviews(req, res) {
  const items = await TransferReview.find({
    userId: getUserId(req)
  })
    .sort({ createdAt: -1 })
    .limit(20)
    .populate('toAccountId', 'accountNumber nickname')
    .lean();

  return res.json({
    reviews: items.map(item => ({
      id: String(item._id),
      amount: money(item.amountCents),
      status: item.status,
      createdAt: item.createdAt,
      recipient:
        item.toAccountId?.nickname ||
        `•••• ${item.toAccountId?.accountNumber?.slice(-4) || ''}`
    }))
  });
}

async function listSessions(req, res) {
  const sessions = await DeviceSession.find({
    userId: getUserId(req)
  })
    .sort({ lastSeenAt: -1 })
    .lean();

  return res.json({
    sessions: sessions.map(item => ({
      id: String(item._id),
      label: item.label,
      lastSeenAt: item.lastSeenAt,
      current: item.sessionId === req.sessionID
    }))
  });
}

async function revokeSession(req, res) {
  const device = await DeviceSession.findOne({
    _id: req.params.id,
    userId: getUserId(req)
  });

  if (!device) {
    return res.status(404).json({
      error: 'Session not found.'
    });
  }

  const isCurrent = device.sessionId === req.sessionID;

  await mongoose.connection
    .collection('web_sessions')
    .deleteOne({ _id: device.sessionId });

  await device.deleteOne();

  if (isCurrent) {
    return req.session.destroy(() => {
      res.clearCookie('harborline.sid');

      return res.json({
        message: 'This session was signed out.',
        current: true
      });
    });
  }

  return res.json({
    message: 'Session signed out.',
    current: false
  });
}

async function markNotificationRead(req, res) {
  const item = await Notification.findOneAndUpdate(
    {
      _id: req.params.id,
      userId: getUserId(req)
    },
    { readAt: new Date() },
    { new: true }
  );

  if (!item) {
    return res.status(404).json({
      error: 'Notification not found.'
    });
  }

  return res.json({ ok: true });
}

module.exports = {
  currentUser,
  listTransactions,
  updatePreferences,
  transfer,
  listSessions,
  revokeSession,
  markNotificationRead,
  downloadStatement,
  listScheduledTransfers,
  cancelScheduledTransfer,
  listTransferReviews
};
