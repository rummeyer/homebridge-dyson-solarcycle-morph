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

import { DysonCloud, isBluetoothLight } from '../dist/dyson/cloud.js';
import { describeError } from '../dist/errors.js';
import { CredentialStore } from '../dist/dyson/credentials.js';
import { PLUGIN_NAME } from '../dist/settings.js';

/**
 * Dyson serials look like `ABC-EU-XXXXXXXX`, and a device advertises its serial
 * as its BLE name. That is all the advertisement gives us: a vacuum and a light
 * expose the same service UUID and carry no manufacturer data, so which is
 * which comes from the account, never from the scan.
 */
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

    this.onRequest('/auth-status', (r) => this.authStatus(r));
    this.onRequest('/start-auth', (r) => this.startAuth(r));
    this.onRequest('/finish-auth', (r) => this.finishAuth(r));
    this.onRequest('/lights', (r) => this.lights(r));
    this.onRequest('/pair', (r) => this.pair(r));
    this.onRequest('/pair-status', (r) => this.pairStatus(r));
    this.onRequest('/forget', (r) => this.forget(r));
    this.onRequest('/sign-out', (r) => this.signOut(r));

    this.ready();
  }

  store() {
    return new CredentialStore(this.homebridgeStoragePath, PLUGIN_NAME);
  }

  /**
   * Map serial numbers to BLE addresses by scanning.
   *
   * The account supplies the serials; this only fills in how to reach them.
   */
  async scanForAddresses() {
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

      const addresses = new Map();
      for (const mac of await adapter.devices()) {
        try {
          const name = await (await adapter.getDevice(mac)).getName();
          if (SERIAL_PATTERN.test(name)) {
            addresses.set(name.toUpperCase(), mac);
          }
        } catch {
          // Devices come and go mid-scan; a disappearing one is not an error.
        }
      }

      // Leave discovery as we found it: the plugin may be mid-reconnect.
      if (!alreadyScanning) {
        await adapter.stopDiscovery().catch(() => {});
      }
      return addresses;
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

  /**
   * Report whether this account still holds a usable session.
   *
   * A stored token is not the same as a working one, so this exercises it
   * against the API rather than merely noting that it exists.
   */
  async authStatus(request) {
    const { email } = this.getAccount(request);
    const stored = await this.store().getAccount(email);
    if (!stored) {
      return { authorised: false, reason: 'no-token' };
    }
    try {
      const { country } = this.getAccount(request);
      const devices = await new DysonCloud({ country, culture: cultureFor(country) }).getDevices(stored.token);
      return { authorised: true, created: stored.created, devices: devices.length };
    } catch (err) {
      return {
        authorised: false,
        reason: 'rejected',
        created: stored.created,
        message: `Dyson no longer accepts the stored authorisation (${describeError(err)}). Request a new code.`,
      };
    }
  }

  /**
   * List the account's lights, with a BLE address where one was found.
   *
   * Category comes from the account because the advertisement cannot supply it:
   * a robot vacuum and a light look identical over Bluetooth.
   */
  async lights(request) {
    const { email, country } = this.getAccount(request);
    const stored = await this.store().getAccount(email);
    if (!stored) {
      throw new RequestError('Authorise your MyDyson account first.');
    }

    let devices;
    try {
      devices = await new DysonCloud({ country, culture: cultureFor(country) }).getDevices(stored.token);
    } catch (err) {
      throw new RequestError(`Could not list your Dyson devices: ${describeError(err)}`);
    }

    const lights = devices.filter(isBluetoothLight);
    if (lights.length === 0) {
      return {
        lights: [],
        skipped: devices.map((d) => ({ serial: d.serialNumber, name: d.name, category: d.category })),
      };
    }

    const addresses = await this.scanForAddresses();
    return {
      lights: lights.map((d) => ({
        serial: d.serialNumber,
        name: d.name,
        model: d.model ?? d.type ?? null,
        mac: addresses.get(String(d.serialNumber).toUpperCase()) ?? null,
      })),
      skipped: devices.filter((d) => !isBluetoothLight(d)).map((d) => ({
        serial: d.serialNumber,
        name: d.name,
        category: d.category,
      })),
    };
  }

  /** Fetch and store one lamp's long-term key. */
  async pair(request) {
    const { email, country } = this.getAccount(request);
    const serial = typeof request?.serial === 'string' ? request.serial.trim().toUpperCase() : '';
    if (!serial) {
      throw new RequestError('No serial number given.');
    }
    const store = this.store();
    const stored = await store.getAccount(email);
    if (!stored) {
      throw new RequestError('Authorise your MyDyson account first.');
    }
    try {
      const cloud = new DysonCloud({ country, culture: cultureFor(country) });
      const ltk = await cloud.fetchLtk(serial, stored.token);
      await store.set(serial, { ltk, accountId: stored.accountId });
      return { message: `Paired ${serial}. Press Save, then restart Homebridge.` };
    } catch (err) {
      throw new RequestError(
        String(err).includes('404')
          ? `${serial} is not registered to this Dyson account. Add it in the MyDyson app first.`
          : `Could not fetch the key for ${serial}: ${describeError(err)}`,
      );
    }
  }

  /** Discard the stored session, e.g. to authorise as a different account. */
  async signOut(request) {
    const { email } = this.getAccount(request);
    await this.store().deleteAccount(email);
    return { message: 'Signed out. Request a new code to authorise again.' };
  }

  /** Report which of the given serials already have stored credentials. */
  async pairStatus(request) {
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

  /** Exchange the code for a session token and remember it. */
  async finishAuth(request) {
    const { email, country, password } = this.getAccount(request);
    const otpCode = typeof request?.otpCode === 'string' ? request.otpCode.trim() : '';

    if (!password) {
      throw new RequestError('Enter your MyDyson password.');
    }
    if (!otpCode) {
      throw new RequestError('Enter the code from the Dyson email.');
    }
    const challenge = this.challenges.get(email);
    if (!challenge) {
      throw new RequestError('Request a code first — the previous one is no longer pending.');
    }

    try {
      const cloud = new DysonCloud({ country, culture: cultureFor(country) });
      const { token, accountId } = await cloud.completeLogin(email, password, challenge.challengeId, otpCode);
      await this.store().setAccount(email, { token, accountId });
      return { message: 'Account authorised. Now find your lights below.' };
    } catch (err) {
      throw new RequestError(`Login failed: ${describeError(err)}`);
    } finally {
      // One code is good for one login, so a retry needs a fresh one either way.
      this.challenges.delete(email);
    }
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

  /** Account details come from the config block the settings page maintains. */
  getAccount(request) {
    const account = request?.account ?? {};
    const email = typeof account.email === 'string' ? account.email.trim() : '';
    const country =
      typeof account.country === 'string' && account.country.trim() ? account.country.trim().toUpperCase() : 'GB';
    if (!email) {
      throw new RequestError('Enter the email address of your MyDyson account.');
    }
    return { email, country, password: typeof account.password === 'string' ? account.password : '' };
  }
}

/** Dyson wants a BCP 47 culture; derive a reasonable one from the country. */
function cultureFor(country) {
  const languages = { DE: 'de', AT: 'de', CH: 'de', FR: 'fr', IT: 'it', ES: 'es', NL: 'nl' };
  return `${languages[country] ?? 'en'}-${country}`;
}


new MorphUiServer();
