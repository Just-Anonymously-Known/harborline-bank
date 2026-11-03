
const mongoose = require('mongoose');
const crypto = require('crypto');

const Card = require('../models/Card');
const CardTransaction = require('../models/CardTransaction');
const Account = require('../models/Account');
const LedgerEntry = require('../models/LedgerEntry');

const { cents, money } = require('../utils/finance');
const { notify } = require('../services/notificationService');
const { sendTransactionAlert } = require('../services/emailAlertService');

const PURCHASE_CATEGORIES = [
  'Food & drink',
  'Home & bills',
  'Shopping',
  'Transport',
  'Health',
  'Other'
];

function getUserId(req) {
  return req.session.user.id;
}

function getAmount(value) {
  const amount = cents(value);

  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return null;
  }

  return amount;
}

function getDescription(value, fallback = 'Card purchase') {
  return String(value || fallback).trim().slice(0, 100) || fallback;
}

function getCategory(value) {
  return PURCHASE_CATEGORIES.includes(value) ? value : 'Other';
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

async function sendAlertSafely(userId, subject, message) {
  try {
    await sendTransactionAlert(userId, subject, message);
  } catch (error) {
    // The transaction has already committed. Do not report it as failed
    // just because an email notification could not be sent.
    console.error('Transaction email alert failed:', error.message);
  }
}

async function listCards(req, res) {
  const userId = getUserId(req);

  let cards = await Card.find({ userId })
    .sort({ cardType: 1 })
    .lean();

  if (!cards.length) {
    const generatedCards = await Card.create(
      [
        {
          userId,
          cardType: 'debit',
          last4: String(crypto.randomInt(0, 10000)).padStart(4, '0')
        },
        {
          userId,
          cardType: 'credit',
          last4: String(crypto.randomInt(0, 10000)).padStart(4, '0'),
          creditLimitCents: 500000
        }
      ],
      { ordered: true }
    );

    cards = generatedCards.map(card => card.toObject());
  }

  return res.json({
    cards: cards.map(card => ({
      id: String(card._id),
      cardType: card.cardType,
      last4: card.last4,
      status: card.status,
      creditLimit: money(card.creditLimitCents),
      balance: money(card.balanceCents),
      rewardsPoints: card.rewardsPoints
    }))
  });
}

async function setCardStatus(req, res) {
  const userId = getUserId(req);
  const status = req.body.status;

  if (!['active', 'locked'].includes(status)) {
    return res.status(400).json({
      error: 'Choose active or locked.'
    });
  }

  const card = await Card.findOneAndUpdate(
    {
      userId,
      cardType: req.params.type
    },
    { status },
    { new: true, runValidators: true }
  );

  if (!card) {
    return res.status(404).json({
      error: 'Card not found.'
    });
  }

  return res.json({
    message: `${card.cardType === 'debit' ? 'Debit' : 'Credit'} card ${status}.`,
    status: card.status
  });
}

async function debitPurchase(req, res) {
  const userId = getUserId(req);
  const amount = getAmount(req.body.amount);

  if (!amount) {
    return res.status(400).json({
      error: 'Enter a valid purchase amount.'
    });
  }

  const description = getDescription(req.body.description);
  const category = getCategory(req.body.category);

  const dbSession = await mongoose.startSession();
  let remainingBalance;

  try {
    await dbSession.withTransaction(async () => {
      const card = await Card.findOne({
        userId,
        cardType: 'debit'
      }).session(dbSession);

      const account = await Account.findOne({
        userId,
        accountType: 'checking'
      }).session(dbSession);

      if (!card || !account) {
        throw createHttpError(
          'Debit card or checking account unavailable.',
          404
        );
      }

      if (card.status !== 'active') {
        throw createHttpError(
          'Unlock your debit card before using it.'
        );
      }

      if (account.status !== 'active') {
        throw createHttpError('This account is frozen.');
      }

      if (account.balanceCents < amount) {
        throw createHttpError('Insufficient checking balance.');
      }

      account.balanceCents -= amount;
      remainingBalance = account.balanceCents;

      await account.save({ session: dbSession });

      await LedgerEntry.create(
        [
          {
            transferGroup: `purchase-${crypto.randomUUID()}`,
            accountId: account._id,
            kind: 'card_purchase',
            amountCents: amount,
            balanceAfterCents: remainingBalance,
            description,
            category
          }
        ],
        { session: dbSession, ordered: true }
      );

      await CardTransaction.create(
        [
          {
            userId,
            cardId: card._id,
            kind: 'purchase',
            amountCents: amount,
            description,
            category
          }
        ],
        { session: dbSession, ordered: true }
      );

      await notify(
        userId,
        'Debit card purchase',
        `$${money(amount)} at ${description}.`,
        dbSession
      );
    });
  } catch (error) {
    return sendError(res, error);
  } finally {
    await dbSession.endSession();
  }

  await sendAlertSafely(
    userId,
    'Debit card purchase',
    `$${money(amount)} at ${description}.`
  );

  return res.json({
    message: 'Card purchase recorded.',
    balance: money(remainingBalance)
  });
}

async function creditPurchase(req, res) {
  const userId = getUserId(req);
  const amount = getAmount(req.body.amount);

  if (!amount) {
    return res.status(400).json({
      error: 'Enter a valid purchase amount.'
    });
  }

  const description = getDescription(req.body.description);
  const category = getCategory(req.body.category);

  const dbSession = await mongoose.startSession();
  let cardBalance;

  try {
    await dbSession.withTransaction(async () => {
      const card = await Card.findOne({
        userId,
        cardType: 'credit'
      }).session(dbSession);

      if (!card) {
        throw createHttpError('Credit card unavailable.', 404);
      }

      if (card.status !== 'active') {
        throw createHttpError(
          'Unlock your credit card before using it.'
        );
      }

      if (card.balanceCents + amount > card.creditLimitCents) {
        throw createHttpError(
          'Purchase exceeds the available credit.'
        );
      }

      card.balanceCents += amount;
      card.rewardsPoints += Math.floor(amount / 100);
      cardBalance = card.balanceCents;

      await card.save({ session: dbSession });

      await CardTransaction.create(
        [
          {
            userId,
            cardId: card._id,
            kind: 'purchase',
            amountCents: amount,
            description,
            category
          }
        ],
        { session: dbSession, ordered: true }
      );

      await notify(
        userId,
        'Credit card purchase',
        `$${money(amount)} at ${description}.`,
        dbSession
      );
    });
  } catch (error) {
    return sendError(res, error);
  } finally {
    await dbSession.endSession();
  }

  await sendAlertSafely(
    userId,
    'Credit card purchase',
    `$${money(amount)} at ${description}.`
  );

  return res.json({
    message: 'Card purchase recorded.',
    balance: money(cardBalance)
  });
}

async function payCreditCard(req, res) {
  const userId = getUserId(req);
  const amount = getAmount(req.body.amount);

  if (!amount) {
    return res.status(400).json({
      error: 'Enter a valid payment amount.'
    });
  }

  const dbSession = await mongoose.startSession();
  let cardBalance;

  try {
    await dbSession.withTransaction(async () => {
      const card = await Card.findOne({
        userId,
        cardType: 'credit'
      }).session(dbSession);

      const account = await Account.findOne({
        userId,
        accountType: 'checking'
      }).session(dbSession);

      if (!card || !account) {
        throw createHttpError(
          'Credit card or checking account unavailable.',
          404
        );
      }

      if (account.status !== 'active') {
        throw createHttpError('This account is frozen.');
      }

      if (card.balanceCents < amount) {
        throw createHttpError(
          'Payment exceeds the credit card balance.'
        );
      }

      if (account.balanceCents < amount) {
        throw createHttpError('Insufficient checking balance.');
      }

      card.balanceCents -= amount;
      account.balanceCents -= amount;
      cardBalance = card.balanceCents;

      await card.save({ session: dbSession });
      await account.save({ session: dbSession });

      await CardTransaction.create(
        [
          {
            userId,
            cardId: card._id,
            kind: 'payment',
            amountCents: amount,
            description: 'Credit card payment',
            category: 'Payment'
          }
        ],
        { session: dbSession, ordered: true }
      );

      await LedgerEntry.create(
        [
          {
            transferGroup: `card-payment-${crypto.randomUUID()}`,
            accountId: account._id,
            kind: 'card_payment',
            amountCents: amount,
            balanceAfterCents: account.balanceCents,
            description: 'Credit card payment',
            category: 'Other'
          }
        ],
        { session: dbSession, ordered: true }
      );

      await notify(
        userId,
        'Credit card payment',
        `A $${money(amount)} payment was made.`,
        dbSession
      );
    });
  } catch (error) {
    return sendError(res, error);
  } finally {
    await dbSession.endSession();
  }

  await sendAlertSafely(
    userId,
    'Credit card payment',
    `A $${money(amount)} payment was made from checking.`
  );

  return res.json({
    message: 'Credit card payment recorded.',
    cardBalance: money(cardBalance)
  });
}

async function creditStatement(req, res) {
  const month = String(
    req.query.month || new Date().toISOString().slice(0, 7)
  );

  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return res.status(400).json({
      error: 'Choose a valid month.'
    });
  }

  const [year, monthNumber] = month.split('-').map(Number);

  const start = new Date(Date.UTC(year, monthNumber - 1, 1));
  const end = new Date(Date.UTC(year, monthNumber, 1));

  const card = await Card.findOne({
    userId: getUserId(req),
    cardType: 'credit'
  }).lean();

  if (!card) {
    return res.status(404).json({
      error: 'Credit card unavailable.'
    });
  }

  const activity = await CardTransaction.find({
    cardId: card._id,
    createdAt: {
      $gte: start,
      $lt: end
    }
  })
    .sort({ createdAt: -1 })
    .lean();

  const purchases = activity
    .filter(item => item.kind === 'purchase')
    .reduce((sum, item) => sum + item.amountCents, 0);

  const payments = activity
    .filter(item => item.kind === 'payment')
    .reduce((sum, item) => sum + item.amountCents, 0);

  return res.json({
    month,
    balance: money(card.balanceCents),
    creditLimit: money(card.creditLimitCents),
    purchases: money(purchases),
    payments: money(payments),
    rewardsPoints: card.rewardsPoints,
    activity: activity.map(item => ({
      ...item,
      amount: money(item.amountCents)
    }))
  });
}

module.exports = {
  listCards,
  setCardStatus,
  debitPurchase,
  creditPurchase,
  payCreditCard,
  creditStatement
};
