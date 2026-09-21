export interface ThoughtSpotCredentials {
  host: string;
  username: string;
  password: string;
}

export interface ThoughtSpotToken {
  token: string;
  expiresAt: string;
  username: string;
}

export const TOKEN_VALIDITY_SECONDS = 300;
const TOKEN_PATH = '/api/rest/2.0/auth/token/full';

export class ThoughtSpotAuthError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'ThoughtSpotAuthError';
  }
}

interface FullTokenResponse {
  token?: string;
  expiration_time_in_millis?: number;
  valid_for_username?: string;
}

export async function mintToken(
  creds: ThoughtSpotCredentials,
  fetchImpl: typeof fetch = fetch,
  validitySeconds = TOKEN_VALIDITY_SECONDS
): Promise<ThoughtSpotToken> {
  const url = new URL(TOKEN_PATH, creds.host);
  if (url.protocol !== 'https:') throw new ThoughtSpotAuthError('ThoughtSpot host must be https', 500);
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ username: creds.username, password: creds.password, validity_time_in_sec: validitySeconds }),
  });
  if (!res.ok) {
    throw new ThoughtSpotAuthError(`ThoughtSpot token request failed with status ${res.status}`, res.status);
  }
  const body = (await res.json()) as FullTokenResponse;
  if (!body.token) throw new ThoughtSpotAuthError('ThoughtSpot token response had no token', 502);
  const expiresAt = body.expiration_time_in_millis
    ? new Date(body.expiration_time_in_millis).toISOString()
    : new Date(Date.now() + validitySeconds * 1000).toISOString();
  return { token: body.token, expiresAt, username: body.valid_for_username ?? creds.username };
}
