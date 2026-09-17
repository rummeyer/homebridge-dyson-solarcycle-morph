/**
 * Minimal Dyson cloud client — just enough to obtain the long-term key (LTK)
 * that the lamp's offline handshake needs.
 *
 * This runs once, during pairing. Normal operation never touches the network.
 */

/** The `X-Dyson-ApiAuthCode` the LTK endpoint accepts in place of a session code. */
const LTK_AUTH_CODE = '80541406';

/** The MyDyson Android app identifies itself with exactly this string. */
const USER_AGENT = 'android client';

/** Only China has a dedicated endpoint; everything else uses the global one. */
function apiHostname(country: string): string {
  return country.toUpperCase() === 'CN' ? 'https://appapi.cp.dyson.cn' : 'https://appapi.cp.dyson.com';
}

export interface LoginResult {
  /** Bearer token for subsequent calls. */
  token: string;
  /** Account GUID — goes into re-auth PayloadA verbatim. */
  accountId: string;
}

export interface CloudOptions {
  /** ISO 3166-1 alpha-2, e.g. `DE`. Selects the regional endpoint. */
  country?: string;
  /** BCP 47 culture, e.g. `de-DE`. */
  culture?: string;
  timeoutMs?: number;
  /** Log every request and response. Never logs credentials or tokens. */
  debug?: boolean;
}

export class DysonCloud {
  private readonly country: string;
  private readonly culture: string;
  private readonly timeoutMs: number;
  private readonly debug: boolean;

  constructor(options: CloudOptions = {}) {
    this.country = options.country ?? 'DE';
    this.culture = options.culture ?? 'de-DE';
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.debug = options.debug ?? false;
  }

  /**
   * Start a login. Dyson emails a one-time code and returns the challenge it
   * belongs to.
   *
   * @returns The `challengeId` to pass to {@link completeLogin}.
   */
  async beginLogin(email: string): Promise<string> {
    // The API rejects clients that have not announced themselves recently.
    await this.request('GET', '/v1/provisioningservice/application/Android/version');
    await this.request('POST', '/v3/userregistration/email/userstatus', {
      query: { country: this.country },
      body: { email },
    });
    const data = await this.request<{ challengeId: string }>('POST', '/v3/userregistration/email/auth', {
      query: { country: this.country, culture: this.culture },
      body: { email },
    });
    if (!data.challengeId) {
      throw new Error('Dyson did not return a challengeId — is the email registered?');
    }
    return data.challengeId;
  }

  /** Exchange the emailed one-time code for a bearer token and account GUID. */
  async completeLogin(
    email: string,
    password: string,
    challengeId: string,
    otpCode: string,
  ): Promise<LoginResult> {
    const data = await this.request<{ token: string; account: string }>(
      'POST',
      '/v3/userregistration/email/verify',
      {
        query: { country: this.country, culture: this.culture },
        body: { challengeId, email, otpCode, password },
      },
    );
    if (!data.token || !data.account) {
      throw new Error('Dyson login succeeded but returned no token/account');
    }
    return { token: data.token, accountId: data.account };
  }

  /**
   * Fetch a lamp's long-term key.
   *
   * Requires the lamp to already be registered to this account in the MyDyson
   * app; otherwise the endpoint returns 404 and you need the physical
   * fresh-pairing flow instead.
   */
  async fetchLtk(serial: string, token: string): Promise<string> {
    const data = await this.request<{ ltk: string }>('GET', `/v1/lec/${encodeURIComponent(serial)}/ltk`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Dyson-ApiAuthCode': LTK_AUTH_CODE,
      },
    });
    if (!data.ltk) {
      throw new Error(`Dyson returned no LTK for ${serial}`);
    }
    return data.ltk;
  }

  private async request<T = unknown>(
    method: 'GET' | 'POST',
    path: string,
    options: {
      query?: Record<string, string>;
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ): Promise<T> {
    const url = new URL(path, apiHostname(this.country));
    for (const [k, v] of Object.entries(options.query ?? {})) {
      url.searchParams.set(k, v);
    }

    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
      ...options.headers,
    };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    if (this.debug) {
      console.error(`→ ${method} ${url}`);
      console.error(`  headers: ${JSON.stringify(redact(headers))}`);
      console.error(`  body:    ${JSON.stringify(redact(options.body))}`);
    }

    const response = await fetch(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const text = await response.text();

    if (this.debug) {
      console.error(`← ${response.status} ${response.statusText}`);
      console.error(`  headers: ${JSON.stringify(Object.fromEntries(response.headers))}`);
      console.error(`  body:    ${text.slice(0, 500)}`);
    }

    if (!response.ok) {
      throw new Error(
        `Dyson API ${method} ${path} failed: ${response.status} ${response.statusText} ${text.slice(0, 300)}`,
      );
    }

    if (!text) {
      return {} as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Dyson API ${method} ${path} returned non-JSON: ${text.slice(0, 200)}`);
    }
  }
}

/** Strip anything credential-shaped so debug output is safe to paste. */
function redact(value: unknown): unknown {
  if (value === undefined || value === null || typeof value !== 'object') {
    return value;
  }
  const secret = /password|token|otp|ltk|authorization|apiauthcode/i;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, secret.test(k) ? '<redacted>' : v]),
  );
}
