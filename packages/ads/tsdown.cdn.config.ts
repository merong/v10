import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { UserConfig } from 'tsdown';
import { defineConfig } from 'tsdown';
import { copyCssPlugin } from '../../build/plugins/copy-css-plugin.ts';

const skinsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../skins/src');

type BuildMode = 'dev' | 'prod';

const buildModes: BuildMode[] = ['dev', 'prod'];

const entries = [
  { src: 'src/cdn/videojs-ads.ts', name: 'videojs-ads' },
  { src: 'src/cdn/video-ads.ts', name: 'video-ads' },
];

const configs: UserConfig[] = [];

// Each entry gets its own config to prevent code splitting between them.
// This ensures each bundle is fully self-contained.
for (const { src, name } of entries) {
  for (const mode of buildModes) {
    const isProd = mode === 'prod';

    configs.push({
      entry: { [isProd ? name : `${name}.dev`]: src },
      platform: 'browser',
      format: 'es',
      target: 'es2022',
      sourcemap: true,
      clean: false,
      dts: false,
      minify: isProd,
      noExternal: [/.*/],
      outDir: 'cdn',
      define: {
        __DEV__: isProd ? 'false' : 'true',
      },
      inputOptions: {
        onwarn(warning, defaultHandler) {
          if (warning.code === 'COMMONJS_VARIABLE_IN_ESM') return;
          defaultHandler(warning);
        },
      },
    });
  }
}

// Classic-script build of the integrated bundle, for pages that cannot set
// `type="module"`. It carries the same exports on a `VideojsAds` global.
// Only the production mode is built — a page reaching for a global is shipping,
// not debugging.
configs.push({
  entry: { 'video-ads': 'src/cdn/video-ads.ts' },
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  // No map for the same reason only prod is built: this output is for shipping.
  // The dev ESM bundles are where debugging happens.
  sourcemap: false,
  clean: false,
  dts: false,
  minify: true,
  noExternal: [/.*/],
  outDir: 'cdn',
  // tsdown appends `.iife.js` for this format, so the entry name stays bare.
  outputOptions: { name: 'VideojsAds' },
  // Emitted once for the whole cdn/ directory; the ESM builds share it.
  plugins: [copyCssPlugin({ skinsDir, outDir: 'cdn', inline: false })],
  define: {
    __DEV__: 'false',
  },
  inputOptions: {
    onwarn(warning, defaultHandler) {
      if (warning.code === 'COMMONJS_VARIABLE_IN_ESM') return;
      defaultHandler(warning);
    },
  },
});

export default defineConfig(configs);
