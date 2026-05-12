const TOKEN_URL = 'https://services.leadconnectorhq.com/oauth/token';
const AUTHORIZE_URL = 'https://marketplace.leadconnectorhq.com/oauth/chooselocation';

export function buildAuthorizeUrl({ clientId, redirectUri, scopes }) {
  const u = new URL(AUTHORIZE_URL);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', scopes.join(' '));
  return u.toString();
}

async function postForm(body) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(body).toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GHL token ${res.status}: ${text}`);
  return JSON.parse(text);
}

export async function exchangeCode({ code, clientId, clientSecret, redirectUri, userType = 'Location' }) {
  const data = await postForm({
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
    user_type: userType,
  });
  return normalize(data);
}

export async function refreshToken({ refreshToken, clientId, clientSecret, userType = 'Location' }) {
  const data = await postForm({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    user_type: userType,
  });
  return normalize(data);
}

function normalize(d) {
  return {
    accessToken: d.access_token,
    refreshToken: d.refresh_token,
    expiresIn: d.expires_in,
    expiresAt: Date.now() + (d.expires_in || 0) * 1000,
    scope: d.scope,
    tokenType: d.token_type,
    userType: d.userType,
    companyId: d.companyId,
    locationId: d.locationId,
    userId: d.userId,
    raw: d,
  };
}
