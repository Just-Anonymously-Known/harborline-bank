const serverless = require('serverless-http');
require('express-async-errors');
const { connectDatabase, seedAdmin } = require('../../config/database');
const { createApp } = require('../../app');
const { isStrongPassword } = require('../../utils/identity');

let initialization;

async function getHandler() {
  if (!initialization) {
    initialization = (async () => {
      if (process.env.NODE_ENV === 'production' && (
        !process.env.APP_ORIGIN || !process.env.MAIL_FROM ||
        (!process.env.BREVO_API_KEY && (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASSWORD)) ||
        !process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32 ||
        !process.env.ADMIN_EMAIL || !isStrongPassword(process.env.ADMIN_PASSWORD, 16)
      )) throw new Error('Set APP_ORIGIN, complete SMTP settings, SESSION_SECRET (32+ characters), and strong seeded admin credentials in Netlify environment variables.');
      await connectDatabase();
      await seedAdmin();
      return serverless(createApp());
    })();
  }
  try {
    return await initialization;
  } catch (error) {
    initialization = null;
    throw error;
  }
}

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  const handler = await getHandler();
  return handler(event, context);
};
