import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { UserConfig } from 'tsdown';
import { defineConfig } from 'tsdown';
import { copyCssPlugin } from '../../build/plugins/copy-css-plugin.ts';

// The overlay stylesheet has no `@import`, so nothing needs resolving against
// the skins directory — `inline: false` keeps the file copied verbatim.
const skinsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../skins/src');

type BuildMode = 'dev' | 'default';

const buildModes: BuildMode[] = ['dev', 'default'];

const createConfig = (mode: BuildMode): UserConfig => ({
  entry: {
    index: 'src/index.ts',
    dom: 'src/dom.ts',
  },
  platform: 'neutral',
  format: 'es',
  sourcemap: true,
  clean: true,
  hash: false,
  unbundle: true,
  outDir: `dist/${mode}`,
  define: {
    __DEV__: mode === 'dev' ? 'true' : 'false',
  },
  dts: mode === 'dev',
  plugins: [copyCssPlugin({ skinsDir, outDir: `dist/${mode}`, inline: false })],
});

export default defineConfig(buildModes.map((mode) => createConfig(mode)));
