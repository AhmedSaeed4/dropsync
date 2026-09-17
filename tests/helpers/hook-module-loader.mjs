// Order 20 — module resolver for the REAL-hook tests. The app resolves
// '@/...' through its bundler; node --test needs the map spelled out. The
// jsdom dev dependency lives OUTSIDE the repo (npm reify must never run on
// the /mnt/d mount), so the bare specifier is resolved against the
// WSL-native install. Registered by editorialWindowHook.test.mjs. This file
// lives under tests/helpers/ so the tests/*.mjs suite glob never executes it.
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const requireFromTestLibs = createRequire(`${homedir()}/test-libs/jsdom/`);
const jsdomEntry = pathToFileURL(requireFromTestLibs.resolve('jsdom')).href;

export async function resolve(specifier, context, next) {
  if (specifier === 'jsdom') return next(jsdomEntry, context);
  if (specifier.startsWith('@/')) {
    const rest = specifier.slice(2);
    const withExt = /\.(ts|tsx|js|mjs)$/.test(rest) ? rest : `${rest}.ts`;
    return next(new URL(`../../src/${withExt}`, import.meta.url).href, context);
  }
  return next(specifier, context);
}
