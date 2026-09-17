/**
 * Persistent storage for lamp credentials.
 *
 * The long-term key is a device credential, and `config.json` is the wrong
 * place for it: the Homebridge UI shows that file, it gets pasted into support
 * threads, and it is backed up wherever the storage directory is not. Keys live
 * here instead, in the same node-persist store the custom UI writes to, so
 * pairing never has to round-trip through the config at all.
 */
import { join } from 'node:path';

import storage from 'node-persist';

/** What pairing produces for one lamp. */
export interface StoredCredentials {
  /** Long-term key as hex. */
  ltk: string;
  /** Dyson account GUID the key was issued to. */
  accountId: string;
  /** ISO timestamp, so the UI can say how old an authorisation is. */
  created: string;
}

export class CredentialStore {
  private readonly directory: string;
  private store: ReturnType<typeof storage.create> | undefined;

  /** @param storagePath Homebridge's storage directory. */
  constructor(storagePath: string, pluginName: string) {
    this.directory = join(storagePath, pluginName, 'persist');
  }

  private async open(): Promise<ReturnType<typeof storage.create>> {
    if (!this.store) {
      const store = storage.create({ dir: this.directory });
      await store.init();
      this.store = store;
    }
    return this.store;
  }

  /** Serials are case-insensitive in practice; normalise so lookups agree. */
  private static key(serial: string): string {
    return `${serial.trim().toUpperCase()}:credentials`;
  }

  async get(serial: string): Promise<StoredCredentials | undefined> {
    const stored: unknown = await (await this.open()).getItem(CredentialStore.key(serial));
    if (!stored || typeof stored !== 'object') {
      return undefined;
    }
    const { ltk, accountId } = stored as Partial<StoredCredentials>;
    // A half-written entry is worse than none: it would fail the handshake with
    // a confusing crypto error rather than an obvious "not paired yet".
    return ltk && accountId ? (stored as StoredCredentials) : undefined;
  }

  async set(serial: string, credentials: Omit<StoredCredentials, 'created'>): Promise<void> {
    await (await this.open()).setItem(CredentialStore.key(serial), {
      ...credentials,
      created: new Date().toISOString(),
    });
  }

  async delete(serial: string): Promise<void> {
    await (await this.open()).removeItem(CredentialStore.key(serial));
  }

  /** Serials that have stored credentials. */
  async list(): Promise<string[]> {
    const keys: string[] = await (await this.open()).keys();
    return keys.filter((k) => k.endsWith(':credentials')).map((k) => k.slice(0, -':credentials'.length));
  }
}
