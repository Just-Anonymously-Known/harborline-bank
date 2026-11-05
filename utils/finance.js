function cents(input) {
  const value = String(input ?? '').trim();
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const amount = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

function money(amountCents) {
  return (Number(amountCents) / 100).toFixed(2);
}

// Human-readable amount with thousands separators, e.g. 1,000,000.00 (for messages, emails and receipts).
function fmtMoney(amountCents) {
  return (Number(amountCents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

module.exports = { cents, money, fmtMoney };
