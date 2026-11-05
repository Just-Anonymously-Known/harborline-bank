const path = require('path');
const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const helmet = require('helmet');
const authRoutes = require('./routes/authRoutes');
const customerRoutes = require('./routes/customerRoutes');
const adminRoutes = require('./routes/adminRoutes');
const maintenanceRoutes = require('./routes/maintenanceRoutes');
const supportRoutes = require('./routes/supportRoutes');
const { apiLimiter } = require('./middleware/rateLimiters');
const { attachCsrfRoutes, requireSameOriginAndCsrf } = require('./middleware/csrfProtection');
const { isAllowedOrigin } = require('./utils/origins');
const { processDueTransfers } = require('./services/scheduledTransferService');

function createApp() {
  const app = express();
  const isProduction = process.env.NODE_ENV === 'production';
  app.set('trust proxy', 1);
  app.set('etag', false);
  // Stay signed in until the customer signs out (renewed on every visit).
  const SESSION_MS = 1000 * 60 * 60 * 24 * 30;

  // Allow the deployed Netlify frontend(s) to call this API with session cookies.
  app.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin && isAllowedOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
    }
    if (req.method === 'OPTIONS') {
      if (!origin || !isAllowedOrigin(origin)) return res.sendStatus(403);
      return res.sendStatus(204);
    }
    next();
  });

  // Lightweight check for hosting health monitors and uptime pings (no database or session needed).
  app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

  app.use(helmet({ contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
    fontSrc: ["'self'", 'https://fonts.gstatic.com'],
    scriptSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:'],
    connectSrc: ["'self'", 'https://harborline-bank.onrender.com']
  } } }));
  app.use(express.json({ limit: '20kb' }));
  app.use(session({
    store: MongoStore.create({
      mongoUrl: process.env.MONGODB_URI,
      collectionName: 'web_sessions',
      mongoOptions: { maxPoolSize: 5 },
      ttl: SESSION_MS / 1000,
      touchAfter: 15 * 60,
      autoRemove: 'native'
    }),
    name: 'harborline.sid',
    secret: process.env.SESSION_SECRET,
    resave: false,
    rolling: true,
    saveUninitialized: false,
    cookie: { httpOnly: true, secure: isProduction, sameSite: isProduction ? 'none' : 'lax', maxAge: SESSION_MS }
  }));

  // Account data must never be cached by the browser or a CDN.
  app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); res.vary('Cookie'); next(); });

  app.get('/api/csrf', attachCsrfRoutes);
  app.use(requireSameOriginAndCsrf);
  app.use('/api', apiLimiter);
  app.use('/api', (req, res, next) => { processDueTransfers().catch(error => console.error('Scheduled transfer processing failed:', error)); next(); });
  app.use('/api', authRoutes);
  app.use('/api', supportRoutes);
  app.use('/api', customerRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/maintenance', maintenanceRoutes);
  app.use('/api', (err, req, res, next) => {
    console.error(err);
    if (res.headersSent) return next(err);
    const safe = err.code === 'EMAIL_DELIVERY' || (err.status && err.status < 500 && err.expose !== false);
    res.status(err.status || 500).json({ error: safe ? err.message : 'Something went wrong. Please try again.' });
  });

  app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: isProduction ? '1h' : 0 }));
  app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
  return app;
}

module.exports = { createApp };
