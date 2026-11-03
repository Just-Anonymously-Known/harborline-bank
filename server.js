require('dotenv').config();
require('express-async-errors');

const { connectDatabase, seedAdmin } = require('./config/database');
const { createApp } = require('./app');
const { processDueTransfers } = require('./services/scheduledTransferService');
const { isStrongPassword } = require('./utils/identity');

const port = Number(process.env.PORT || 3000);

async function start() {
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
    throw new Error('Set SESSION_SECRET in .env to at least 32 characters.');
  }
  if (process.env.NODE_ENV === 'production' && (
    !process.env.APP_ORIGIN || !process.env.MAIL_FROM ||
    (!process.env.BREVO_API_KEY && (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASSWORD)) ||
    !process.env.ADMIN_EMAIL || !isStrongPassword(process.env.ADMIN_PASSWORD, 16)
  )) {
    throw new Error('Production requires APP_ORIGIN, complete SMTP settings, and strong seeded admin credentials.');
  }

  await connectDatabase();
  await seedAdmin();
  setInterval(() => processDueTransfers().catch(error => console.error('Scheduled transfer processing failed:', error)), 60 * 1000).unref();
  const app = createApp();
  app.listen(port, () => console.log(`Harborline is running at http://localhost:${port}`));
}

start().catch(error => {
  console.error(error);
  process.exit(1);
});
