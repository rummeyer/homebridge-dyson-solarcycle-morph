#!/usr/bin/env node
/**
 * One-time pairing helper.
 *
 * Logs in to the Dyson cloud, fetches the lamp's long-term key, and stores it
 * where the plugin will find it. After this the plugin never needs network
 * access again.
 *
 * Most people should use the plugin's settings page in the Homebridge UI
 * instead; this exists for setups without it.
 *
 * Usage: dyson-morph-pair [--serial ABC-EU-…] [--country DE] [--culture de-DE]
 *                        [--email …] [--storage …] [--debug]
 */
import { createInterface, type Interface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { homedir } from 'node:os';
import { join } from 'node:path';

import { DysonCloud } from '../dyson/cloud.js';
import { CredentialStore } from '../dyson/credentials.js';
import { PLUGIN_NAME } from '../settings.js';

interface Args {
  debug?: string;
  serial?: string;
  storage?: string;
  mac?: string;
  country?: string;
  culture?: string;
  email?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const match = /^--([a-z]+)(?:=(.*))?$/.exec(argv[i]!);
    if (!match) {
      continue;
    }
    const key = match[1] as keyof Args;
    // --debug is a flag, not a value; don't let it swallow the next argument.
    args[key] = key === 'debug' ? (match[2] ?? 'true') : (match[2] ?? argv[++i]);
  }
  return args;
}

/**
 * Prompts the user, or replays piped input.
 *
 * Readline hands over every buffered line the moment stdin delivers it, so a
 * question asked after the first would miss its answer when input is piped.
 * For non-interactive input we therefore read stdin to EOF up front and answer
 * from that queue; only a real TTY goes through readline.
 */
class Prompter {
  private readonly rl: Interface | undefined;
  private scripted: string[] | undefined;

  constructor(interactive: boolean) {
    this.rl = interactive ? createInterface({ input: stdin, output: stdout }) : undefined;
  }

  async ask(query: string): Promise<string> {
    if (this.rl) {
      return this.rl.question(query);
    }
    this.scripted ??= await readAllLines();
    stdout.write(`${query}\n`);
    return this.scripted.shift() ?? '';
  }

  /**
   * Ask without echoing, so the password stays out of the terminal and its
   * scrollback. Readline has no masking, so we intercept its output: the
   * prompt goes through once, the keystrokes echoed after it do not.
   */
  async askSecret(query: string): Promise<string> {
    if (!this.rl) {
      return this.ask(query);
    }
    const internals = this.rl as unknown as { _writeToOutput: (text: string) => void };
    const write = internals._writeToOutput;
    let promptShown = false;
    internals._writeToOutput = (text: string): void => {
      if (!promptShown && text.includes(query)) {
        write.call(this.rl, text);
        promptShown = true;
      }
    };
    try {
      return await this.rl.question(query);
    } finally {
      internals._writeToOutput = write;
      stdout.write('\n');
    }
  }

  close(): void {
    this.rl?.close();
  }
}

async function readAllLines(): Promise<string[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8').split('\n');
}

/** Reject empty answers early rather than sending them to Dyson. */
function required(value: string, what: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(
      `No ${what} entered.\n\n` +
        'This tool needs a terminal it can read from. If you started it through an\n' +
        'editor, agent or CI shell, the prompts appear but your typing never reaches\n' +
        'it. Run it directly in a terminal instead.',
    );
  }
  return trimmed;
}

async function main(prompter: Prompter): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!stdin.isTTY) {
    console.error('Note: stdin is not a terminal, so answers are being read from piped input.\n');
  }

  const country = args.country ?? ((await prompter.ask('Country code [DE]: ')).trim() || 'DE');
  const culture = args.culture ?? `${country.toLowerCase()}-${country.toUpperCase()}`;
  const email = required(args.email ?? (await prompter.ask('Dyson account email: ')), 'email address');
  const password = required(await prompter.askSecret('Dyson account password: '), 'password');
  const serial = required(args.serial ?? (await prompter.ask('Lamp serial number: ')), 'serial number').toUpperCase();
  const storagePath = args.storage ?? join(homedir(), '.homebridge');

  const cloud = new DysonCloud({ country, culture, debug: args.debug === 'true' });

  console.log('\nRequesting a one-time code…');
  const challengeId = await cloud.beginLogin(email);
  console.log('Dyson has emailed you a 6-digit code.');
  const otpCode = required(await prompter.ask('Code from the email: '), 'one-time code');

  const { token, accountId } = await cloud.completeLogin(email, password, challengeId, otpCode);
  console.log(`Logged in. Account ${accountId}`);

  console.log(`Fetching the long-term key for ${serial}…`);
  const ltk = await cloud.fetchLtk(serial, token);

  await new CredentialStore(storagePath, PLUGIN_NAME).set(serial, { ltk, accountId });
  console.log(`Stored the key for ${serial} under ${storagePath}.`);

  console.log('\nAdd this to the platforms array in your Homebridge config.json:\n');
  console.log(
    JSON.stringify(
      { platform: 'DysonSolarcycleMorph', lights: [{ name: 'Dyson Morph', mac: '<the lamp BLE address>', serial }] },
      null,
      2,
    ),
  );
  console.log(
    '\nThe key itself is deliberately not shown: it is a device credential, and it now\n' +
      'lives outside config.json. Pass --storage if your Homebridge storage directory is\n' +
      `not ${storagePath}.`,
  );
}

const prompter = new Prompter(Boolean(stdin.isTTY));
main(prompter)
  .catch((error: unknown) => {
    console.error(`\nPairing failed: ${error instanceof Error ? error.message : String(error)}`);
    if (String(error).includes('404')) {
      console.error(
        'A 404 from the LTK endpoint usually means the lamp is not registered to this\n' +
          'Dyson account. Add it in the MyDyson app first, then run this again.',
      );
    }
    process.exitCode = 1;
  })
  .finally(() => prompter.close());
