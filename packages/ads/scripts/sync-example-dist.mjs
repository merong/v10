/**
 * Copies the built CDN bundles into `examples/ads/dist/` so the example loads
 * only from its own folder.
 *
 * The example demonstrates three ways to load the player, and they need
 * different things from this directory:
 *
 *   - `video-ads.iife.js`  — one file, nothing else. IIFE cannot code-split.
 *   - `videojs-ads.js`     — one file. Ads only; the player comes from a CDN.
 *   - `video-ads.js`       — plus every locale chunk it imports on demand.
 *
 * That last case is why this copies the whole directory rather than three
 * files: the ESM bundle resolves its chunks relative to itself, so a partial
 * copy fails at runtime the moment a locale is requested.
 *
 * Source maps are skipped. They are four times the size of the code and the
 * example is not a debugging target.
 */
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(packageDir, 'cdn');
const target = resolve(packageDir, '../../examples/ads/dist');

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// The example is optional. Removing it should not break the package build.
if (!(await exists(resolve(target, '..')))) {
  process.exit(0);
}

if (!(await exists(source))) {
  console.error('sync-example-dist: no cdn/ output — run the CDN build first');
  process.exit(1);
}

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });

let copied = 0;

for (const entry of await readdir(source, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.js')) continue;

  await cp(join(source, entry.name), join(target, entry.name));
  copied += 1;
}

console.log(`sync-example-dist: copied ${copied} files to examples/ads/dist`);
