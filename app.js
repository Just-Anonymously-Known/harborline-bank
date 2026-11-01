const path = require('path');
const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const helmet = require('helmet');
const authRoutes = require('./routes/authRoutes');
const customerRoutes = require('./routes/customerRoutes');
const adminRoutes = require('./routes/adminRoutes');
const maintenanceRoutes = require('./routes/maintenanceRoutes');
const { apiLimiter } = require('./middleware/rateLimiters');
const { attachCsrfRoutes, requireSameOriginAndCsrf } = require('./middleware/csrfProtection');
const { processDueTransfers } = require('./services/scheduledTransferService');

function createApp() {
  const app = express();
  const isProduction = process.env.NODE_ENV === 'production';
  app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
    fontSrc: ["'self'", 'https://fonts.gstatic.com'],
    scriptSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:'],
    connectSrc: ["'self'"]
  } } }));
  app.use(express.json({ limit: '20kb' }));
  app.use(session({
    store: MongoStore.create({
      mongoUrl: process.env.MONGODB_URI,
      collectionName: 'web_sessions',
      mongoOptions: { maxPoolSize: 5 },
      ttl: 60 * 60 * 8,
      autoRemove: 'native'
    }),
    name: 'harborline.sid',
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, secure: isProduction, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 8 }
  }));

  app.get('/api/csrf', attachCsrfRoutes);
  app.use(requireSameOriginAndCsrf);
  app.use('/api', apiLimiter);
  app.use('/api', (req, res, next) => { processDueTransfers().catch(error => console.error('Scheduled transfer processing failed:', error)); next(); });
  app.use('/api', authRoutes);
  app.use('/api', customerRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/maintenance', maintenanceRoutes);
  app.use('/api', (err, req, res, next) => {
    console.error(err);
    if (res.headersSent) return next(err);
    res.status(err.status || 500).json({ error: err.code === 'EMAIL_DELIVERY' ? err.message : 'Something went wrong. Please try again.' });
  });

  app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: isProduction ? '1h' : 0 }));
  app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
  return app;
}

module.exports = { createApp };
