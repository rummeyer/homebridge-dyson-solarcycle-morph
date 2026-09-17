/**
 * Backend for the plugin's settings page in the Homebridge UI.
 *
 * Does the one thing that cannot be done offline: exchange a MyDyson login for
 * a lamp's long-term key. The key is written to the plugin's node-persist
 * store — the same store the running plugin reads — so it never passes through
 * config.json.
 */
import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';
import { createBluetooth } from 'node-ble';

import { DysonCloud } from '../dist/dyson/cloud.js';
import { CredentialStore } from '../dist/dyson/credentials.js';
import { PLUGIN_NAME } from '../dist/settings.js';

/** Dyson serials look like `ABC-EU-XXXXXXXX`, and the lamp advertises its serial as its BLE name. */
const SERIAL_PATTERN = /^[A-Z0-9]{3}-[A-Z]{2}-[A-Z0-9]{6,}$/;

/** How long to leave BLE discovery running before reporting what turned up. */
const SCAN_MS = 12_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class MorphUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();

    // Dyson's login is two calls with an emailed code in between. The challenge
    // id ties them together, and it only has to survive between two requests
    // from the same open settings page, so memory is the right place for it —
    // writing it to disk would outlive its usefulness.
    this.challenges = new Map();

    this.onRequest('/discover', (r) => this.discover(r));
    this.onRequest('/status', (r) => this.status(r));
    this.onRequest('/start-auth', (r) => this.startAuth(r));
    this.onRequest('/finish-auth', (r) => this.finishAuth(r));
    this.onRequest('/forget', (r) => this.forget(r));

    this.ready();
  }

  store() {
    return new CredentialStore(this.homebridgeStoragePath, PLUGIN_NAME);
  }

  /** Scan for nearby lamps so the address and serial need not be typed. */
  async discover() {
    let session;
    try {
      session = createBluetooth();
      const adapter = await session.bluetooth.defaultAdapter();

      if (!(await adapter.isPowered())) {
        throw new RequestError('The Bluetooth adapter is powered off. Run: bluetoothctl power on');
      }
      const alreadyScanning = await adapter.isDiscovering();
      if (!alreadyScanning) {
        await adapter.startDiscovery();
      }
      await sleep(SCAN_MS);

      const found = [];
      for (const mac of await adapter.devices()) {
        try {
          const device = await adapter.getDevice(mac);
          const name = await device.getName();
          if (SERIAL_PATTERN.test(name)) {
            found.push({ mac, serial: name });
          }
        } catch {
          // Devices come and go mid-scan; a disappearing one is not an error.
        }
      }

      // Leave discovery as we found it: the plugin may be mid-reconnect.
      if (!alreadyScanning) {
        await adapter.stopDiscovery().catch(() => {});
      }
      return { found };
    } catch (err) {
      if (err instanceof RequestError) {
        throw err;
      }
      throw new RequestError(`Bluetooth scan failed: ${describeError(err)}`);
    } finally {
      try {
        session?.destroy();
      } catch {
        // Nothing useful to do if the D-Bus connection was already gone.
      }
    }
  }

  /** Report which of the given serials already have stored credentials. */
  async status(request) {
    const serials = Array.isArray(request?.serials) ? request.serials : [];
    const store = this.store();
    const paired = {};
    for (const serial of serials) {
      if (typeof serial !== 'string' || !serial.trim()) {
        continue;
      }
      const stored = await store.get(serial);
      paired[serial] = stored ? { created: stored.created } : null;
    }
    return { paired };
  }

  /** Ask Dyson to email a one-time code. */
  async startAuth(request) {
    const { email, country } = this.getAccount(request);
    try {
      const cloud = new DysonCloud({ country, culture: cultureFor(country) });
      const challengeId = await cloud.beginLogin(email);
      this.challenges.set(email, { challengeId, country });
      return { message: 'Dyson has emailed you a code. Check your spam folder too.' };
    } catch (err) {
      throw new RequestError(`Could not request a code: ${describeError(err)}`);
    }
  }

  /** Exchange the code for a token, then fetch and store each lamp's key. */
  async finishAuth(request) {
    const { email, country } = this.getAccount(request);
    const password = request?.password;
    const otpCode = typeof request?.otpCode === 'string' ? request.otpCode.trim() : '';
    const serials = (Array.isArray(request?.serials) ? request.serials : [])
      .filter((s) => typeof s === 'string' && s.trim())
      .map((s) => s.trim().toUpperCase());

    if (typeof password !== 'string' || !password) {
      throw new RequestError('Enter your MyDyson password.');
    }
    if (!otpCode) {
      throw new RequestError('Enter the code from the Dyson email.');
    }
    if (serials.length === 0) {
      throw new RequestError('Add a light with its serial number below before authorising.');
    }
    const challenge = this.challenges.get(email);
    if (!challenge) {
      throw new RequestError('Request a code first — the previous one is no longer pending.');
    }

    const cloud = new DysonCloud({ country, culture: cultureFor(country) });
    let token;
    let accountId;
    try {
      ({ token, accountId } = await cloud.completeLogin(email, password, challenge.challengeId, otpCode));
    } catch (err) {
      throw new RequestError(`Login failed: ${describeError(err)}`);
    }
    // One code is good for one login, so a retry needs a fresh one either way.
    this.challenges.delete(email);

    const store = this.store();
    const results = [];
    for (const serial of serials) {
      try {
        const ltk = await cloud.fetchLtk(serial, token);
        await store.set(serial, { ltk, accountId });
        results.push({ serial, paired: true });
      } catch (err) {
        const notFound = String(err).includes('404');
        results.push({
          serial,
          paired: false,
          message: notFound
            ? 'Not registered to this Dyson account. Add it in the MyDyson app first.'
            : describeError(err),
        });
      }
    }

    const ok = results.filter((r) => r.paired).length;
    return {
      results,
      message:
        ok === serials.length
          ? `Paired ${ok} light${ok === 1 ? '' : 's'}. Save the configuration and restart Homebridge.`
          : `Paired ${ok} of ${serials.length}. See the details below.`,
    };
  }

  /** Discard a stored key, e.g. before re-pairing against another account. */
  async forget(request) {
    const serial = typeof request?.serial === 'string' ? request.serial.trim() : '';
    if (!serial) {
      throw new RequestError('No serial number given.');
    }
    await this.store().delete(serial);
    return { message: `Removed the stored key for ${serial}.` };
  }

  getAccount(request) {
    const email = typeof request?.email === 'string' ? request.email.trim() : '';
    const country =
      typeof request?.country === 'string' && request.country.trim() ? request.country.trim().toUpperCase() : 'GB';
    if (!email) {
      throw new RequestError('Enter the email address of your MyDyson account.');
    }
    return { email, country };
  }
}

/** Dyson wants a BCP 47 culture; derive a reasonable one from the country. */
function cultureFor(country) {
  const languages = { DE: 'de', AT: 'de', CH: 'de', FR: 'fr', IT: 'it', ES: 'es', NL: 'nl' };
  return `${languages[country] ?? 'en'}-${country}`;
}

/**
 * Describe an error usefully.
 *
 * A bare message hides the HTTP status when Dyson refused, which is the single
 * most useful thing to know when this flow fails.
 */
function describeError(err) {
  if (!(err instanceof Error)) {
    return String(err);
  }
  const parts = [err.message];
  let cause = err.cause;
  while (cause instanceof Error && parts.length < 3) {
    parts.push(`caused by ${cause.message}`);
    cause = cause.cause;
  }
  return parts.join(' — ');
}

new MorphUiServer();
