// Shared transport rules. Credentials (proxy API key, management key) may only
// travel in clear text to a strict loopback address; anything else must be HTTPS.
// Kept in one place so the status line and the profile prober cannot drift.

export function isStrictLoopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true;
  const octets = host.split('.');
  return (
    octets.length === 4 &&
    octets[0] === '127' &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}

// Returns the normalized origin, or null when the URL is unusable or would leak
// a credential over plaintext to a non-loopback host.
export function normalizeCredentialedBase(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.protocol === 'http:' && !isStrictLoopbackHost(url.hostname)) return null;
    return url.href.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

// A 2xx from /v1/models is the only accepted proof that an endpoint is usable.
// Redirects are not followed: a redirect target could be off-loopback.
export async function probeEndpoint(base, apiKey, timeoutMs = 3000) {
  const normalized = normalizeCredentialedBase(base);
  if (!normalized || !apiKey) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${normalized}/v1/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      redirect: 'manual',
      signal: controller.signal,
    });
    return response.status >= 200 && response.status < 300;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
