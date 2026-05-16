import type { UserConfig } from 'tsdown';
import { defineConfig } from 'tsdown';

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

export default defineConfig(configs);
