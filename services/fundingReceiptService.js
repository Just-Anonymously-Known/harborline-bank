const PDFDocument = require('pdfkit');

const { money } = require('../utils/finance');

const BRAND = {
  navy: '#081827',
  blue: '#42A5FF',
  lightBlue: '#EAF4FF',
  text: '#1E293B',
  muted: '#64748B',
  border: '#D9E2EC',
  white: '#FFFFFF',
  green: '#15803D'
};

function maskAccountNumber(accountNumber = '') {
  const value = String(accountNumber);
  if (!value) return '••••';
  return `•••• ${value.slice(-4)}`;
}

function formatDate(date) {
  const value = date ? new Date(date) : new Date();

  return value.toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
    timeZoneName: 'short'
  });
}

function safeText(value, fallback = '—') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

/**
 * Generates a PDF funding receipt and returns it as a Buffer.
 *
 * Required:
 *   customer: { name, email }
 *   account: { accountNumber, accountType, nickname, currency }
 *   ledgerEntry: { transferGroup, createdAt, description }
 *   amount: amount in cents
 *   balance: resulting balance in cents
 *
 * Optional:
 *   previousBalance: previous balance in cents
 *   logoPath: path to a PNG/JPG Harborline logo
 */
async function generateFundingReceipt({
  customer,
  account,
  ledgerEntry,
  amount,
  balance,
  previousBalance,
  logoPath
}) {
  if (!customer || !account || !ledgerEntry) {
    throw new Error('Customer, account, and ledger entry are required to generate a receipt.');
  }

  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error('Receipt amount must be a positive integer in cents.');
  }

  if (!Number.isSafeInteger(balance) || balance < 0) {
    throw new Error('Receipt balance must be a valid integer in cents.');
  }

  const currency = safeText(account.currency, 'USD');
  const reference = safeText(ledgerEntry.transferGroup);
  const accountName = safeText(account.nickname || account.accountType);
  const accountNumber = maskAccountNumber(account.accountNumber);
  const customerName = safeText(customer.name);
  const customerEmail = safeText(customer.email);
  const transactionDate = formatDate(ledgerEntry.createdAt);
  const description = safeText(ledgerEntry.description, 'Funds added by administrator');

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: {
          top: 48,
          bottom: 48,
          left: 48,
          right: 48
        },
        info: {
          Title: 'Harborline Account Funding Receipt',
          Author: 'Harborline',
          Subject: 'Administrator account funding confirmation'
        }
      });

      const chunks = [];

      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const pageWidth = doc.page.width;
      const contentWidth = pageWidth - doc.page.margins.left - doc.page.margins.right;
      const left = doc.page.margins.left;
      const right = left + contentWidth;

      // Header background
      doc.save();
      doc.rect(0, 0, pageWidth, 118).fill(BRAND.navy);
      doc.restore();

      // Logo: use supplied image if available, otherwise draw a branded mark.
      if (logoPath) {
        try {
          doc.image(logoPath, left, 38, {
            fit: [44, 44]
          });
        } catch (error) {
          drawBrandMark(doc, left, 38);
        }
      } else {
        drawBrandMark(doc, left, 38);
      }

      doc
        .fillColor(BRAND.white)
        .font('Helvetica-Bold')
        .fontSize(23)
        .text('harborline', left + 56, 43);

      doc
        .fillColor('#B9D8F5')
        .font('Helvetica')
        .fontSize(9)
        .text('ACCOUNT FUNDING RECEIPT', left + 56, 72);

      doc
        .fillColor(BRAND.white)
        .font('Helvetica-Bold')
        .fontSize(10)
        .text('COMPLETED', right - 95, 48, {
          width: 95,
          align: 'right'
        });

      // Main title
      doc
        .fillColor(BRAND.text)
        .font('Helvetica-Bold')
        .fontSize(20)
        .text('Funds added successfully', left, 145);

      doc
        .fillColor(BRAND.muted)
        .font('Helvetica')
        .fontSize(10)
        .text('This receipt confirms that funds were credited to your Harborline account.', left, 174, {
          width: contentWidth
        });

      // Amount panel
      const panelY = 210;
      const panelHeight = 92;

      doc
        .roundedRect(left, panelY, contentWidth, panelHeight, 8)
        .fill(BRAND.lightBlue);

      doc
        .fillColor(BRAND.muted)
        .font('Helvetica')
        .fontSize(9)
        .text('AMOUNT CREDITED', left + 18, panelY + 17);

      doc
        .fillColor(BRAND.navy)
        .font('Helvetica-Bold')
        .fontSize(27)
        .text(`${currency} ${money(amount)}`, left + 18, panelY + 36);

      // Transaction details
      let y = 330;

      doc
        .fillColor(BRAND.text)
        .font('Helvetica-Bold')
        .fontSize(12)
        .text('Transaction details', left, y);

      y += 24;

      drawDetail(doc, 'Transaction reference', reference, left, y, contentWidth);
      y += 39;

      drawDetail(doc, 'Date and time (UTC)', transactionDate, left, y, contentWidth);
      y += 39;

      drawDetail(doc, 'Funding source', 'Administrator', left, y, contentWidth);
      y += 39;

      drawDetail(doc, 'Description', description, left, y, contentWidth);
      y += 39;

      // Account details section
      y += 10;

      doc
        .fillColor(BRAND.text)
        .font('Helvetica-Bold')
        .fontSize(12)
        .text('Account details', left, y);

      y += 24;

      drawDetail(doc, 'Account holder', customerName, left, y, contentWidth);
      y += 39;

      drawDetail(doc, 'Customer email', customerEmail, left, y, contentWidth);
      y += 39;

      drawDetail(doc, 'Account', `${accountName} (${accountNumber})`, left, y, contentWidth);
      y += 39;

      if (Number.isSafeInteger(previousBalance) && previousBalance >= 0) {
        drawDetail(doc, 'Previous balance', `${currency} ${money(previousBalance)}`, left, y, contentWidth);
        y += 39;
      }

      drawDetail(doc, 'Balance after funding', `${currency} ${money(balance)}`, left, y, contentWidth);

      // Footer
      const footerY = doc.page.height - 75;

      doc
        .moveTo(left, footerY)
        .lineTo(right, footerY)
        .strokeColor(BRAND.border)
        .lineWidth(1)
        .stroke();

      doc
        .fillColor(BRAND.muted)
        .font('Helvetica')
        .fontSize(8)
        .text(
          'This receipt is for your records. Harborline will never ask you to share your password, PIN, or one-time verification code.',
          left,
          footerY + 12,
          {
            width: contentWidth,
            align: 'center'
          }
        );

      doc
        .fillColor(BRAND.muted)
        .fontSize(8)
        .text('Harborline • Demo banking application', left, footerY + 35, {
          width: contentWidth,
          align: 'center'
        });

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

function drawBrandMark(doc, x, y) {
  doc
    .save()
    .circle(x + 22, y + 22, 21)
    .lineWidth(2)
    .strokeColor(BRAND.blue)
    .stroke();

  doc
    .moveTo(x + 22, y + 9)
    .lineTo(x + 22, y + 35)
    .moveTo(x + 9, y + 22)
    .lineTo(x + 35, y + 22)
    .lineWidth(2)
    .strokeColor(BRAND.blue)
    .stroke();

  doc.restore();
}

function drawDetail(doc, label, value, x, y, width) {
  doc
    .fillColor(BRAND.muted)
    .font('Helvetica')
    .fontSize(9)
    .text(label, x, y, {
      width: width * 0.42
    });

  doc
    .fillColor(BRAND.text)
    .font('Helvetica-Bold')
    .fontSize(9)
    .text(safeText(value), x + width * 0.42, y, {
      width: width * 0.58,
      align: 'right'
    });

  doc
    .moveTo(x, y + 24)
    .lineTo(x + width, y + 24)
    .strokeColor(BRAND.border)
    .lineWidth(0.5)
    .stroke();
}

module.exports = {
  generateFundingReceipt
};