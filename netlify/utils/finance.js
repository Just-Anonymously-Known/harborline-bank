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

module.exports = { cents, money };
