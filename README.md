# Harborline

Harborline is a banking-style web application with customer signup, email OTP verification, account balances, customer-to-customer transfers, an administrator account, administrator funding controls, and opted-in customer email.

## Add your local services

1. Install Node.js 20 or newer.
2. Create a MongoDB Atlas cluster and database user. In Atlas, open **Connect → Drivers** and copy the Node.js connection string. Replace its username/password placeholders and allow your current development IP in Atlas Network Access. The app uses MongoDB transactions, so use Atlas or another MongoDB replica set.
3. For Gmail SMTP, turn on 2-Step Verification for the Google account and create an App Password. Use the Gmail address as `SMTP_USER` and the generated App Password as `SMTP_PASSWORD`. Google may not offer App Passwords for some account types or security configurations; see [Google's App Password help](https://support.google.com/accounts/answer/185833?hl=en).
4. Open `.env` and add your MongoDB connection string, Gmail address, App Password, a strong administrator email/password, and a random session secret. Keep `.env` private and out of Git; it is excluded by `.gitignore`.
5. From the workspace root, run these Bash commands:

   ```bash
   cd outputs/harborline-bank
   npm install
   npm start
   ```

6. Open `http://localhost:3000`. Create a customer account; OTP messages arrive at the configured Gmail inbox. Sign in as admin using the credentials in `.env`.

Your Atlas connection string has this form:

```text
mongodb+srv://DB_USER:DB_PASSWORD@YOUR_CLUSTER.mongodb.net/harborline?retryWrites=true&w=majority
```

If the database username or password contains reserved URL characters, percent-encode those characters in the URI. Atlas shows the connection string for your own cluster; its host is unique to that cluster. See [MongoDB's connection guide](https://www.mongodb.com/docs/drivers/node/current/connect/connection-targets/).

## Environment variables

| Variable | Purpose |
| --- | --- |
| `MONGODB_URI` | MongoDB Atlas or replica set connection string |
| `SESSION_SECRET` | Random secret, at least 32 characters |
| `ADMIN_EMAIL` | Email used by the seeded admin account |
| `ADMIN_PASSWORD` | Admin password; at least 16 characters with uppercase, lowercase, number, and special character in production |
| `ADMIN_NAME` | Optional name shown for the admin |
| `BREVO_API_KEY` | Optional. Sends email over HTTPS via Brevo; use on hosts that block SMTP (Render free plan). When set, the `SMTP_*` values are not needed. `MAIL_FROM` must be a sender verified in Brevo. |
| `SMTP_HOST` | Gmail SMTP host, `smtp.gmail.com` |
| `SMTP_PORT` | Gmail SMTP port, `587` |
| `SMTP_SECURE` | `false` for port 587 |
| `SMTP_USER` | Your Gmail address |
| `SMTP_PASSWORD` | Google App Password, entered without spaces |
| `MAIL_FROM` | Sender name/address, using the configured Gmail address |
| `APP_ORIGIN` | The app's base web address. Keep `http://localhost:3000` locally; use the exact deployed HTTPS address in production. |
| `NODE_ENV` | Set to `production` when deployed |
| `PORT` | Optional server port; defaults to `3000` |

`MAIL_FROM` is the sender label customers see, usually `Harborline <your-address@gmail.com>`. Use the same Gmail address for `SMTP_USER` and `MAIL_FROM`.

The seeded admin is created or refreshed from `ADMIN_EMAIL` and `ADMIN_PASSWORD` on server startup. New customer accounts have a zero balance until an administrator funds them. Account numbers are generated automatically and can be changed from the administrator dashboard. Change seeded admin values in the host's secret settings before deployment. Production startup requires the database, SMTP, app origin, and admin settings.

## Features

- Signup, sign-in, and password recovery use expiring six-digit email codes.
- Passwords are stored as bcrypt hashes; sessions are stored in MongoDB.
- New accounts start at zero. Account numbers are generated automatically and administrators can change them.
- Customer transfers honor a daily limit and update both balances in one MongoDB transaction.
- Customers can schedule one-time transfers up to a year ahead, cancel upcoming transfers, and see scheduled, completed, or failed status. A Netlify scheduled function processes queued transfers every minute; the local server also runs a one-minute worker.
- Customer activity filters include text, category, direction, and date range.
- Customers can load older activity in pages, and administrators can page through large customer lists.
- Administrators can set a per-customer transfer review threshold. Transfers at or above it wait in a review queue; approval rechecks account status, balance, and daily limits before posting the ledger entries.
- Customers and administrators can download a polished HTML account statement for a selected period and print or save it as PDF. 
- Administrators can search accounts, fund customers, create accounts, freeze/unfreeze accounts, set transfer limits, review activity, and email customers who opted in.
- Administrators can create operations or auditor accounts and assign roles. Auditors can view records; only owners can manage administrator access. Every administrator sign-in requires an emailed one-time code.
- The administrator email page can verify SMTP connectivity and authentication. Broadcast and maintenance mail logs show accepted and failed recipient addresses individually; SMTP failures return a safe, actionable message.
- Balance, account, access, limit, email, and maintenance changes require an audit reason, which is stored with the administrator action.
- Customers can change their email preference from their dashboard.
- Customers can enable or disable email alerts for account credits and debits; transfer, admin funding, card, and savings-goal activity sends alerts when enabled.
- Customers can rename accounts, open savings, set and fund goals, lock cards, record card activity, pay a credit card, and download receipts.
- The dashboard includes activity search, spending categories, notifications, signed-in device management, credit statements, and loan/savings calculators.
- Administrators can schedule a maintenance notice, email all verified customers, and show the notice on the site during its scheduled window.
- Administrator actions are recorded in the audit history; balances and transfers are recorded in the ledger.

## Project folders

- `server.js` starts the application and connects the configured services.
- `app.js` configures Express, sessions, security middleware, and route mounting.
- `routes/` maps API URLs to controller actions.
- `controllers/` contains authentication, customer, and administrator request handling.
- `models/` defines MongoDB user, account, ledger, card, savings goal, notification, and audit documents.
- `middleware/` contains session authorization, CSRF/origin checks, and rate limits.
- `config/` contains MongoDB connection and administrator seeding.
- `services/` contains email delivery.
- `services/scheduledTransferService.js` processes due transfers with the same account status, balance, and daily limit checks as immediate transfers.
- `models/TransferReview.js` stores administrator-review requests without changing either account balance until approval.
- `utils/` contains money, identity, and formatting helpers.
- `public/` contains the browser interface.
- `services/fundingReceiptService.js` builds PDF receipts and sends the credit-alert email when an administrator funds an account.
- `services/emailTemplates.js` is the branded HTML layout shared by account alerts, codes and notices.

## Deploy (Render API + Netlify website)

**API on Render.** Create a Web Service from this repository (build `npm install`, start `npm start`) and add these environment variables: `NODE_ENV=production`, `APP_ORIGIN` (the exact Netlify address, e.g. `https://your-site.netlify.app`, no trailing slash), `MONGODB_URI`, `SESSION_SECRET` (32+ characters), `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME`, `MAIL_FROM` and `BREVO_API_KEY`. Render's free plan blocks SMTP ports, which is why email is sent over HTTPS through Brevo; the sender in `MAIL_FROM` must be verified in Brevo. After changing a variable, redeploy.

**Website on Netlify.** Import the same repository. `netlify.toml` publishes `public/` and forwards every `/api/*` call to the Render address in the `to =` line (change it if your Render URL differs). Because the browser only talks to the Netlify address, there are no CORS or third-party-cookie problems.

**Keep the free API awake.** Render's free plan sleeps when idle and the first request afterwards can take a minute. Create a free monitor (for example at uptimerobot.com) that opens `https://YOUR-RENDER-ADDRESS/api/health` every 5 minutes.

## Receipts and credit alerts

- When an administrator funds an account, the customer gets one "Credit alert" email containing the message, the account and new balance, a **View receipt (PDF)** button and the PDF receipt as an attachment. The email respects the customer's alert preference and never delays or blocks the funding itself.
- Every item in a customer's activity list has a **Receipt** button that opens a PDF (`GET /api/receipts/:id`). Customers can only open their own receipts.
- The link in the email opens the site, asks the customer to sign in if needed, and then opens the receipt.

## Customer communication & support

The application includes:
- Customer support tickets (`POST /api/support/tickets`) with ticket persistence in MongoDB.
- Customer ticket history (`GET /api/support/tickets`, authenticated).
- Admin support inbox, email replies, and status updates (`/api/admin/support/tickets`).
- Harborline Assistant FAQ/chat endpoint (`POST /api/assistant/chat`). It is a guided FAQ assistant, not a generative AI model.
- Automatic transaction email alerts for existing successful transfer, card, account, and savings events. Customers can manage the `transactionAlerts` preference in Security Center.

Configure email delivery in `.env`:
```env
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-mailbox-user
SMTP_PASSWORD=your-mailbox-password
MAIL_FROM=Harborline <no-reply@example.com>
SUPPORT_EMAIL=support@example.com
```
`SUPPORT_EMAIL` is the inbox that receives submitted customer support requests. SMTP must be configured for real delivery; in development without SMTP, the mail service logs local-only messages. Do not commit credentials to source control.

The chatbot answers common navigation and banking questions. It does not access balances or perform transactions; customers must use authenticated banking pages for account-specific actions. Never submit passwords, OTPs, PINs, or full card numbers in support forms or chat.
