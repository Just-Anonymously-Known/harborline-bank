// Real visitor address. The website calls /api through Netlify, so on Render every request
// appears to come from Netlify. Without this, all visitors would share one rate-limit bucket.
function clientIp(req) {
  const netlify = String(req.get('x-nf-client-connection-ip') || '').trim();
  if (netlify) return netlify.slice(0, 80);
  const forwarded = String(req.get('x-forwarded-for') || '').split(',')[0].trim();
  return (forwarded || req.ip || '').slice(0, 80);
}

module.exports = { clientIp };
