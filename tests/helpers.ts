import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const FIXTURE_DIR = join(HERE, 'fixtures');
/** Gitignored. Drop your own cards here and they get round-trip tested too. */
export const LOCAL_FIXTURE_DIR = join(FIXTURE_DIR, 'local');

export function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURE_DIR, name)));
}

export function fixtureJson<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf-8')) as T;
}

export interface DiscoveredFixture {
  name: string;
  path: string;
  bytes: Uint8Array;
  /** Fixtures under local/ are the user's own cards; failures there matter most. */
  local: boolean;
}

const CARD_FILE = /\.(png|json)$/i;

function listDir(dir: string, local: boolean): DiscoveredFixture[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && CARD_FILE.test(entry.name))
    .map((entry) => {
      const path = join(dir, entry.name);
      return {
        name: local ? `local/${entry.name}` : entry.name,
        path,
        bytes: new Uint8Array(readFileSync(path)),
        local,
      };
    });
}

/**
 * Every card file under tests/fixtures, including whatever the user dropped
 * into tests/fixtures/local.
 */
export function discoverFixtures(): DiscoveredFixture[] {
  return [...listDir(FIXTURE_DIR, false), ...listDir(LOCAL_FIXTURE_DIR, true)];
}

/** Fixtures that are expected to parse as cards (excludes the negative case). */
export function discoverCardFixtures(): DiscoveredFixture[] {
  return discoverFixtures().filter((f) => !f.name.startsWith('no-card-data'));
}
