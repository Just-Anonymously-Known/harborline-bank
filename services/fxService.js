// Exchange rates for international transfers.
// Live rates come from open.er-api.com (free, no key). If that is unreachable we fall back to the
// last good rates, and finally to built-in reference rates, so the feature never breaks.
const CURRENCIES = [
  ['USD', 'US Dollar'], ['EUR', 'Euro'], ['GBP', 'British Pound'], ['NGN', 'Nigerian Naira'], ['CAD', 'Canadian Dollar'], ['AUD', 'Australian Dollar'],
  ['GHS', 'Ghanaian Cedi'], ['KES', 'Kenyan Shilling'], ['ZAR', 'South African Rand'], ['EGP', 'Egyptian Pound'], ['MAD', 'Moroccan Dirham'], ['TZS', 'Tanzanian Shilling'],
  ['UGX', 'Ugandan Shilling'], ['XOF', 'West African CFA Franc'], ['XAF', 'Central African CFA Franc'], ['ETB', 'Ethiopian Birr'], ['RWF', 'Rwandan Franc'], ['ZMW', 'Zambian Kwacha'],
  ['AED', 'UAE Dirham'], ['SAR', 'Saudi Riyal'], ['QAR', 'Qatari Riyal'], ['KWD', 'Kuwaiti Dinar'], ['ILS', 'Israeli Shekel'], ['TRY', 'Turkish Lira'],
  ['INR', 'Indian Rupee'], ['PKR', 'Pakistani Rupee'], ['BDT', 'Bangladeshi Taka'], ['LKR', 'Sri Lankan Rupee'], ['NPR', 'Nepalese Rupee'],
  ['CNY', 'Chinese Yuan'], ['HKD', 'Hong Kong Dollar'], ['JPY', 'Japanese Yen'], ['KRW', 'South Korean Won'], ['SGD', 'Singapore Dollar'], ['MYR', 'Malaysian Ringgit'],
  ['THB', 'Thai Baht'], ['IDR', 'Indonesian Rupiah'], ['PHP', 'Philippine Peso'], ['VND', 'Vietnamese Dong'], ['TWD', 'New Taiwan Dollar'], ['NZD', 'New Zealand Dollar'],
  ['CHF', 'Swiss Franc'], ['SEK', 'Swedish Krona'], ['NOK', 'Norwegian Krone'], ['DKK', 'Danish Krone'], ['PLN', 'Polish Zloty'], ['CZK', 'Czech Koruna'],
  ['HUF', 'Hungarian Forint'], ['RON', 'Romanian Leu'], ['BGN', 'Bulgarian Lev'], ['UAH', 'Ukrainian Hryvnia'], ['RUB', 'Russian Ruble'],
  ['MXN', 'Mexican Peso'], ['BRL', 'Brazilian Real'], ['ARS', 'Argentine Peso'], ['CLP', 'Chilean Peso'], ['COP', 'Colombian Peso'], ['PEN', 'Peruvian Sol'],
  ['JMD', 'Jamaican Dollar'], ['TTD', 'Trinidad and Tobago Dollar'], ['DOP', 'Dominican Peso']
];
// Reference rates (units per 1 USD), used only if the live service cannot be reached.
const FALLBACK = { USD: 1, EUR: .92, GBP: .78, NGN: 1500, CAD: 1.38, AUD: 1.52, GHS: 15, KES: 129, ZAR: 18, EGP: 49, MAD: 10, TZS: 2650, UGX: 3700, XOF: 600, XAF: 600, ETB: 120, RWF: 1370, ZMW: 27, AED: 3.67, SAR: 3.75, QAR: 3.64, KWD: .31, ILS: 3.7, TRY: 34, INR: 84, PKR: 278, BDT: 120, LKR: 295, NPR: 135, CNY: 7.2, HKD: 7.8, JPY: 152, KRW: 1380, SGD: 1.33, MYR: 4.4, THB: 34, IDR: 15800, PHP: 58, VND: 25000, TWD: 32, NZD: 1.68, CHF: .87, SEK: 10.6, NOK: 11, DKK: 6.9, PLN: 4, CZK: 23, HUF: 370, RON: 4.6, BGN: 1.8, UAH: 41, RUB: 96, MXN: 20, BRL: 5.7, ARS: 980, CLP: 950, COP: 4200, PEN: 3.8, JMD: 157, TTD: 6.8, DOP: 60 };

const FEE_RATE = 0.01, FEE_MIN_CENTS = 250, FEE_MAX_CENTS = 4500;
const TTL = 3 * 60 * 60 * 1000;
let cache = null;

async function getRates() {
  if (cache && Date.now() - cache.at < TTL) return cache;
  try {
    const response = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(4000) });
    const data = await response.json();
    if (data && data.result === 'success' && data.rates && data.rates.EUR) {
      cache = { rates: data.rates, at: Date.now(), source: 'live' };
      return cache;
    }
  } catch (error) { console.error('FX rate lookup failed:', error.message); }
  if (cache && cache.source !== 'reference') { cache = { ...cache, at: Date.now() - TTL + 60 * 1000, source: 'last-known' }; return cache; }
  cache = { rates: FALLBACK, at: Date.now() - TTL + 60 * 1000, source: 'reference' }; // try the live service again in a minute
  return cache;
}

function decimalsFor(code) {
  try { return new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits; } catch { return 2; }
}

async function currencyList() {
  const { rates } = await getRates();
  return CURRENCIES.filter(([code]) => rates[code] || FALLBACK[code]).map(([code, name]) => ({ code, name }));
}

/** Price a transfer. amountCents is USD. Returns null for unsupported currency. */
async function quote(amountCents, currency) {
  const code = String(currency || '').toUpperCase();
  if (!CURRENCIES.some(([c]) => c === code)) return null;
  const { rates, source } = await getRates();
  const rate = Number(rates[code] || FALLBACK[code]);
  if (!rate) return null;
  const feeCents = Math.min(FEE_MAX_CENTS, Math.max(FEE_MIN_CENTS, Math.round(amountCents * FEE_RATE)));
  const factor = Math.pow(10, decimalsFor(code));
  const receiveAmount = Math.floor((amountCents / 100) * rate * factor) / factor;
  return { currency: code, rate, source, feeCents, totalCents: amountCents + feeCents, receiveAmount };
}

module.exports = { CURRENCIES, getRates, currencyList, quote, FEE_RATE, FEE_MIN_CENTS, FEE_MAX_CENTS };
