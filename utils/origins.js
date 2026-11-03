// APP_ORIGIN may hold one or more site addresses separated by commas.
// Trailing slashes and letter-case are ignored, so "https://my-site.netlify.app/"
// still matches the browser's Origin header "https://my-site.netlify.app".
function normalizeOrigin(value) {
  return String(value || '').trim().replace(/\/+$/, '').toLowerCase();
}

function allowedOrigins() {
  return String(process.env.APP_ORIGIN || 'https://harborline-bank.netlify.app')
    .split(',').map(normalizeOrigin).filter(Boolean);
}

function isAllowedOrigin(origin) {
  return allowedOrigins().includes(normalizeOrigin(origin));
}

module.exports = { normalizeOrigin, allowedOrigins, isAllowedOrigin };
