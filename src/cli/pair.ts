#!/usr/bin/env node
/**
 * One-time pairing helper.
 *
 * Logs in to the Dyson cloud, fetches the lamp's long-term key, and prints a
 * ready-to-paste Homebridge config block. After this the plugin never needs
 * network access again.
 *
 * Usage: dyson-morph-pair [--serial ABC-XX-1234] [--mac AA:BB:CC:DD:EE:FF] [--country DE] [--culture de-DE]
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { DysonCloud } from '../dyson/cloud.js';

interface Args {
  serial?: string;
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
    args[key] = match[2] ?? argv[++i];
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rl = createInterface({ input: stdin, output: stdout });

  try {
    const country = args.country ?? ((await rl.question('Country code [DE]: ')).trim() || 'DE');
    const culture = args.culture ?? `${country.toLowerCase()}-${country.toUpperCase()}`;
    const email = args.email ?? (await rl.question('Dyson account email: ')).trim();
    const password = await rl.question('Dyson account password: ');
    const serial = (args.serial ?? (await rl.question('Lamp serial number: '))).trim().toUpperCase();
    const mac = (args.mac ?? (await rl.question('Lamp BLE MAC address: '))).trim().toUpperCase();

    const cloud = new DysonCloud({ country, culture });

    console.log('\nRequesting a one-time code…');
    const challengeId = await cloud.beginLogin(email);
    console.log('Dyson has emailed you a 6-digit code.');
    const otpCode = (await rl.question('Code from the email: ')).trim();

    const { token, accountId } = await cloud.completeLogin(email, password, challengeId, otpCode);
    console.log(`Logged in. Account ${accountId}`);

    console.log(`Fetching the long-term key for ${serial}…`);
    const ltk = await cloud.fetchLtk(serial, token);

    console.log('\nDone. Add this to the platforms array in your Homebridge config.json:\n');
    console.log(
      JSON.stringify(
        {
          platform: 'DysonSolarcycleMorph',
          lights: [{ name: 'Dyson Morph', mac, serial, ltk, accountId, motionSensor: false }],
        },
        null,
        2,
      ),
    );
    console.log('\nThe long-term key is a device credential — treat it like a password.');
  } finally {
    rl.close();
  }
}

main().catch((error: unknown) => {
  console.error(`\nPairing failed: ${error instanceof Error ? error.message : String(error)}`);
  if (String(error).includes('404')) {
    console.error(
      'A 404 from the LTK endpoint usually means the lamp is not registered to this\n' +
        'Dyson account. Add it in the MyDyson app first, then run this again.',
    );
  }
  process.exit(1);
});
