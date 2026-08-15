# Ads Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** JSON API 기반 프리롤 광고 시스템을 Video.js 10 Feature Slice로 구현하고, sandbox 데모에 통합한다.

**Architecture:** `packages/ads/` 에 새 패키지를 생성한다. core/ 에 런타임 비의존 로직 (상태 타입, JSON 클라이언트, 상태 머신), dom/ 에 DOM 전용 로직 (Feature Slice, 오버레이 UI)을 배치한다. sandbox 에 `html-video-ads` 템플릿을 추가하고, 로컬 mock JSON + 샘플 광고 미디어로 동작을 확인한다.

**Tech Stack:** TypeScript, tsdown, Vitest, @videojs/store (definePlayerFeature), @videojs/utils/dom (listen)

---

## File Structure

```
packages/ads/
├── package.json                         # @videojs/ads 패키지 정의
├── tsconfig.json                        # TS 프로젝트 참조 (utils, store 의존)
├── tsdown.config.ts                     # 듀얼 빌드 (dev/default)
├── vitest.config.ts                     # jsdom 환경 테스트
└── src/
    ├── index.ts                         # core 재수출
    ├── dom.ts                           # dom 진입점 (feature + overlay 수출)
    ├── core/
    │   ├── ads-state.ts                 # Ad, AdPhase, MediaAdsState 타입
    │   ├── ads-json-client.ts           # JSON API fetch + 응답 파싱
    │   ├── ads-tracker.ts              # 트래킹 이벤트 전송 (fire-and-forget)
    │   └── tests/
    │       ├── ads-json-client.test.ts
    │       └── ads-tracker.test.ts
    └── dom/
        ├── ads-feature.ts               # Feature Slice (상태 머신 + store 연동)
        ├── ads-overlay.ts               # 오버레이 DOM 생성/관리 (타이머, 스킵, 미디어)
        ├── ads-overlay.css              # 오버레이 스타일
        └── tests/
            ├── ads-feature.test.ts
            └── ads-overlay.test.ts

packages/sandbox/
├── templates/html-video-ads/
│   ├── index.html                       # 광고 데모 HTML
│   └── main.ts                          # 광고 데모 진입점
├── public/
│   └── mock/
│       ├── ads.json                     # Mock 광고 JSON 응답
│       └── ads/                         # 샘플 광고 미디어 파일
│           ├── sample-ad.mp4
│           ├── sample-ad.webm
│           ├── sample-ad.webp
│           └── sample-ad.gif
```

**Workspace 연결 (수정할 기존 파일):**
- `pnpm-workspace.yaml` — 이미 `packages/*` 포함, 변경 불필요
- `tsconfig.json` (root) — `packages/ads` 프로젝트 참조 추가
- `packages/sandbox/package.json` — `@videojs/ads: workspace:*` 의존성 추가
- `packages/sandbox/vite.config.ts` — optimizeDeps.exclude에 `@videojs/ads` 추가
- `packages/sandbox/app/constants.ts` — PRESETS에 `'video-ads'` 추가
- `packages/sandbox/app/shell/navbar.tsx` — PRESET_LABELS에 라벨 추가
- `packages/sandbox/app/shell/app.tsx` — video-ads 경로 매핑 추가

---

## Task 1: 패키지 스캐폴딩

**Files:**
- Create: `packages/ads/package.json`
- Create: `packages/ads/tsconfig.json`
- Create: `packages/ads/tsdown.config.ts`
- Create: `packages/ads/vitest.config.ts`
- Create: `packages/ads/src/index.ts`
- Create: `packages/ads/src/dom.ts`
- Modify: `tsconfig.json` (root)

- [ ] **Step 1: `packages/ads/package.json` 생성**

```json
{
  "name": "@videojs/ads",
  "type": "module",
  "version": "10.0.0-beta.11",
  "private": true,
  "description": "Ad framework for Video.js 10",
  "license": "Apache-2.0",
  "exports": {
    ".": {
      "types": "./dist/dev/index.d.ts",
      "development": "./dist/dev/index.js",
      "default": "./dist/default/index.js"
    },
    "./dom": {
      "types": "./dist/dev/dom.d.ts",
      "development": "./dist/dev/dom.js",
      "default": "./dist/default/dom.js"
    }
  },
  "main": "dist/default/index.js",
  "module": "dist/default/index.js",
  "types": "dist/dev/index.d.ts",
  "files": ["dist"],
  "scripts": {
    "build": "tsdown",
    "build:watch": "tsdown --watch ./src --no-clean",
    "dev": "pnpm run build:watch",
    "test": "vitest run",
    "test:watch": "vitest",
    "clean": "rimraf --glob dist types '*.tsbuildinfo'"
  },
  "dependencies": {
    "@videojs/utils": "workspace:*",
    "@videojs/store": "workspace:*"
  },
  "devDependencies": {
    "jsdom": "^26.1.0",
    "tsdown": "^0.21.4",
    "typescript": "^6.0.2",
    "vitest": "^4.1.0"
  }
}
```

- [ ] **Step 2: `packages/ads/tsconfig.json` 생성**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "declarationDir": "types",
    "lib": ["ES2022", "DOM", "DOM.Iterable"]
  },
  "references": [
    { "path": "../utils" },
    { "path": "../store" }
  ],
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: `packages/ads/tsdown.config.ts` 생성**

```ts
import type { UserConfig } from 'tsdown';
import { defineConfig } from 'tsdown';

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
});

export default defineConfig(buildModes.map((mode) => createConfig(mode)));
```

- [ ] **Step 4: `packages/ads/vitest.config.ts` 생성**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
  },
});
```

- [ ] **Step 5: 빈 진입점 파일 생성**

`packages/ads/src/index.ts`:
```ts
export type { Ad, AdPhase, MediaAdsState } from './core/ads-state';
```

`packages/ads/src/dom.ts`:
```ts
export { adsFeature } from './dom/ads-feature';
export { AdsOverlay } from './dom/ads-overlay';
```

(이 파일들은 이후 태스크에서 참조하는 모듈이 생성되면 완성됨)

- [ ] **Step 6: root `tsconfig.json`에 프로젝트 참조 추가**

`{ "path": "packages/ads" }` 를 references 배열에 추가.

- [ ] **Step 7: pnpm install 실행**

```bash
pnpm install
```

- [ ] **Step 8: 빌드 확인**

```bash
pnpm -F @videojs/ads build
```

- [ ] **Step 9: Commit**

```bash
git add packages/ads/ tsconfig.json
git commit -m "feat(ads): scaffold @videojs/ads package"
```

---

## Task 2: Core 타입 & JSON 클라이언트

**Files:**
- Create: `packages/ads/src/core/ads-state.ts`
- Create: `packages/ads/src/core/ads-json-client.ts`
- Create: `packages/ads/src/core/ads-tracker.ts`
- Create: `packages/ads/src/core/tests/ads-json-client.test.ts`
- Create: `packages/ads/src/core/tests/ads-tracker.test.ts`

- [ ] **Step 1: `ads-state.ts` — 타입 정의**

```ts
export type AdMediaType = 'video' | 'image';

export type AdPhase = 'idle' | 'loading' | 'ready' | 'playing' | 'skipped' | 'done' | 'error';

export interface Ad {
  id: string;
  type: AdMediaType;
  src: string;
  mime: string;
  duration: number;
  skipAfter: number;
  clickUrl?: string;
  trackingUrl?: string;
}

export interface AdsResponse {
  ads: Ad[];
}

export interface MediaAdsState {
  adPhase: AdPhase;
  currentAd: Ad | null;
  adCurrentTime: number;
  adDuration: number;
  skipAvailable: boolean;
  skipCountdown: number;
  loadAds(url: string): Promise<void>;
  skipAd(): void;
}
```

- [ ] **Step 2: JSON 클라이언트 테스트 작성**

`ads-json-client.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import { fetchAds } from '../ads-json-client';

describe('fetchAds', () => {
  it('parses valid ads response', async () => {
    const mockResponse = {
      ads: [{ id: 'ad-1', type: 'video', src: '/ad.mp4', mime: 'video/mp4', duration: 15, skipAfter: 5 }],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(mockResponse) }));

    const result = await fetchAds('/api/ads');
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('ad-1');

    vi.unstubAllGlobals();
  });

  it('returns empty array on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

    const result = await fetchAds('/api/ads');
    expect(result).toHaveLength(0);

    vi.unstubAllGlobals();
  });

  it('returns empty array when ads field is missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }));

    const result = await fetchAds('/api/ads');
    expect(result).toHaveLength(0);

    vi.unstubAllGlobals();
  });

  it('supports AbortSignal', async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError')));

    const result = await fetchAds('/api/ads', controller.signal);
    expect(result).toHaveLength(0);

    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 3: 테스트 실패 확인**

```bash
pnpm -F @videojs/ads test
```

- [ ] **Step 4: `ads-json-client.ts` 구현**

```ts
import { isObject } from '@videojs/utils/predicate';
import type { Ad, AdsResponse } from './ads-state';

function isAd(value: unknown): value is Ad {
  if (!isObject(value)) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    (obj.type === 'video' || obj.type === 'image') &&
    typeof obj.src === 'string' &&
    typeof obj.mime === 'string' &&
    typeof obj.duration === 'number' &&
    typeof obj.skipAfter === 'number'
  );
}

function isAdsResponse(value: unknown): value is AdsResponse {
  if (!isObject(value)) return false;
  const obj = value as Record<string, unknown>;
  return Array.isArray(obj.ads);
}

export async function fetchAds(url: string, signal?: AbortSignal): Promise<Ad[]> {
  try {
    const response = await fetch(url, { signal });
    if (!response.ok) return [];

    const data: unknown = await response.json();
    if (!isAdsResponse(data)) return [];

    return data.ads.filter(isAd);
  } catch {
    return [];
  }
}
```

- [ ] **Step 5: 테스트 통과 확인**

```bash
pnpm -F @videojs/ads test
```

- [ ] **Step 6: 트래커 테스트 작성**

`ads-tracker.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import { trackAdEvent } from '../ads-tracker';

describe('trackAdEvent', () => {
  it('sends POST request with event data', () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);

    trackAdEvent('https://example.com/track', 'impression', { adId: 'ad-1' });

    expect(fetchSpy).toHaveBeenCalledWith('https://example.com/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'impression', adId: 'ad-1' }),
      keepalive: true,
    });

    vi.unstubAllGlobals();
  });

  it('does nothing when url is undefined', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    trackAdEvent(undefined, 'impression');
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 7: `ads-tracker.ts` 구현**

```ts
export function trackAdEvent(
  url: string | undefined,
  event: 'impression' | 'complete' | 'skip' | 'click',
  extra?: Record<string, unknown>
): void {
  if (!url) return;

  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, ...extra }),
    keepalive: true,
  }).catch(() => {});
}
```

- [ ] **Step 8: 전체 테스트 통과 확인**

```bash
pnpm -F @videojs/ads test
```

- [ ] **Step 9: Commit**

```bash
git add packages/ads/src/core/
git commit -m "feat(ads): add core types, JSON client, and tracker"
```

---

## Task 3: Feature Slice (ads-feature.ts)

**Files:**
- Create: `packages/ads/src/dom/ads-feature.ts`
- Create: `packages/ads/src/dom/tests/ads-feature.test.ts`
- Modify: `packages/ads/src/dom.ts`

- [ ] **Step 1: Feature 테스트 작성**

`ads-feature.test.ts`:
```ts
import { createStore } from '@videojs/store';
import { describe, expect, it, vi } from 'vitest';
import { adsFeature } from '../ads-feature';

function createMockMedia(): HTMLVideoElement {
  const video = document.createElement('video');
  // stub play to return resolved promise
  video.play = vi.fn().mockResolvedValue(undefined);
  video.pause = vi.fn();
  return video;
}

describe('adsFeature', () => {
  it('initializes with idle phase', () => {
    const store = createStore<{ media: HTMLVideoElement; container: HTMLElement | null }>()(adsFeature);
    expect(store.state.adPhase).toBe('idle');
    expect(store.state.currentAd).toBeNull();
  });

  it('transitions to loading then ready on loadAds', async () => {
    const mockAd = {
      ads: [{ id: 'ad-1', type: 'video', src: '/ad.mp4', mime: 'video/mp4', duration: 15, skipAfter: 5 }],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(mockAd) }));

    const store = createStore<{ media: HTMLVideoElement; container: HTMLElement | null }>()(adsFeature);
    await store.state.loadAds('/api/ads');

    // After microtask flush
    await new Promise((r) => setTimeout(r, 0));
    expect(store.state.adPhase).toBe('ready');
    expect(store.state.currentAd?.id).toBe('ad-1');

    vi.unstubAllGlobals();
  });

  it('transitions to done when no ads returned', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ads: [] }) }));

    const store = createStore<{ media: HTMLVideoElement; container: HTMLElement | null }>()(adsFeature);
    await store.state.loadAds('/api/ads');

    await new Promise((r) => setTimeout(r, 0));
    expect(store.state.adPhase).toBe('done');

    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

```bash
pnpm -F @videojs/ads test
```

- [ ] **Step 3: `ads-feature.ts` 구현**

```ts
import { defineSlice } from '@videojs/store';
import type { Ad, MediaAdsState } from '../core/ads-state';
import { fetchAds } from '../core/ads-json-client';
import { trackAdEvent } from '../core/ads-tracker';

interface AdsTarget {
  media: HTMLVideoElement;
  container: HTMLElement | null;
}

export const adsFeature = defineSlice<AdsTarget>()({
  name: 'ads',
  state: ({ target, signals, set }): MediaAdsState => {
    let ads: Ad[] = [];
    let rafId = 0;
    let adStartTimestamp = 0;
    let adMediaElement: HTMLVideoElement | HTMLImageElement | null = null;

    function stopAdPlayback(): void {
      cancelAnimationFrame(rafId);
      rafId = 0;
      adStartTimestamp = 0;

      if (adMediaElement) {
        if (adMediaElement instanceof HTMLVideoElement) {
          adMediaElement.pause();
          adMediaElement.removeAttribute('src');
          adMediaElement.load();
        }
        adMediaElement = null;
      }
    }

    function updateAdTime(): void {
      if (adStartTimestamp === 0) return;

      const ad = ads[0];
      if (!ad) return;

      const elapsed = (performance.now() - adStartTimestamp) / 1000;
      const currentTime = Math.min(elapsed, ad.duration);
      const remaining = Math.max(0, ad.skipAfter - elapsed);

      set({
        adCurrentTime: currentTime,
        skipAvailable: ad.skipAfter > 0 && elapsed >= ad.skipAfter,
        skipCountdown: Math.ceil(remaining),
      });

      if (elapsed >= ad.duration) {
        trackAdEvent(ad.trackingUrl, 'complete', { adId: ad.id });
        stopAdPlayback();
        set({ adPhase: 'done', adCurrentTime: ad.duration, skipAvailable: false, skipCountdown: 0 });
        target().media.play().catch(() => {});
        return;
      }

      rafId = requestAnimationFrame(updateAdTime);
    }

    function startAdPlayback(ad: Ad): void {
      const { media, container } = target();
      media.pause();

      adStartTimestamp = performance.now();
      set({
        adPhase: 'playing',
        currentAd: ad,
        adDuration: ad.duration,
        adCurrentTime: 0,
        skipAvailable: ad.skipAfter <= 0,
        skipCountdown: ad.skipAfter > 0 ? ad.skipAfter : 0,
      });

      trackAdEvent(ad.trackingUrl, 'impression', { adId: ad.id });
      rafId = requestAnimationFrame(updateAdTime);
    }

    return {
      adPhase: 'idle',
      currentAd: null,
      adCurrentTime: 0,
      adDuration: 0,
      skipAvailable: false,
      skipCountdown: 0,

      async loadAds(url: string) {
        set({ adPhase: 'loading' });
        const signal = signals.supersede('load-ads');

        ads = await fetchAds(url, signal);

        if (signal.aborted) return;

        if (ads.length === 0) {
          set({ adPhase: 'done' });
          return;
        }

        set({ adPhase: 'ready', currentAd: ads[0]!, adDuration: ads[0]!.duration });
      },

      skipAd() {
        const ad = ads[0];
        if (!ad) return;

        trackAdEvent(ad.trackingUrl, 'skip', { adId: ad.id, time: (performance.now() - adStartTimestamp) / 1000 });
        stopAdPlayback();
        set({
          adPhase: 'skipped',
          skipAvailable: false,
          skipCountdown: 0,
        });

        // Resume content
        target().media.play().catch(() => {});
        set({ adPhase: 'done' });
      },
    };
  },

  attach({ target, signal, get, set }) {
    const { media } = target;

    function onPlay(): void {
      const state = get();
      if (state.adPhase === 'ready' && state.currentAd) {
        // Intercept play — start ad instead
        media.pause();

        const ad = state.currentAd;
        const adStartTimestamp = performance.now();

        set({
          adPhase: 'playing',
          adCurrentTime: 0,
          skipAvailable: ad.skipAfter <= 0,
          skipCountdown: ad.skipAfter > 0 ? ad.skipAfter : 0,
        });

        trackAdEvent(ad.trackingUrl, 'impression', { adId: ad.id });

        let rafId = 0;
        const updateTime = (): void => {
          const elapsed = (performance.now() - adStartTimestamp) / 1000;
          const currentTime = Math.min(elapsed, ad.duration);
          const remaining = Math.max(0, ad.skipAfter - elapsed);

          set({
            adCurrentTime: currentTime,
            skipAvailable: ad.skipAfter > 0 && elapsed >= ad.skipAfter,
            skipCountdown: Math.ceil(remaining),
          });

          if (elapsed >= ad.duration) {
            trackAdEvent(ad.trackingUrl, 'complete', { adId: ad.id });
            set({ adPhase: 'done', adCurrentTime: ad.duration, skipAvailable: false, skipCountdown: 0 });
            media.play().catch(() => {});
            return;
          }

          rafId = requestAnimationFrame(updateTime);
        };

        rafId = requestAnimationFrame(updateTime);

        signal.addEventListener(
          'abort',
          () => {
            cancelAnimationFrame(rafId);
          },
          { once: true }
        );
      }
    }

    media.addEventListener('play', onPlay, { signal });
  },
});
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
pnpm -F @videojs/ads test
```

- [ ] **Step 5: `src/dom.ts` 진입점 업데이트**

```ts
export { adsFeature } from './dom/ads-feature';
export type { MediaAdsState } from './core/ads-state';
```

- [ ] **Step 6: 빌드 확인**

```bash
pnpm -F @videojs/ads build
```

- [ ] **Step 7: Commit**

```bash
git add packages/ads/src/dom/ packages/ads/src/dom.ts
git commit -m "feat(ads): implement ads feature slice with preroll state machine"
```

---

## Task 4: 광고 오버레이 UI

**Files:**
- Create: `packages/ads/src/dom/ads-overlay.ts`
- Create: `packages/ads/src/dom/ads-overlay.css`
- Create: `packages/ads/src/dom/tests/ads-overlay.test.ts`
- Modify: `packages/ads/src/dom.ts`

- [ ] **Step 1: 오버레이 테스트 작성**

`ads-overlay.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { AdsOverlay } from '../ads-overlay';

describe('AdsOverlay', () => {
  it('creates overlay DOM structure', () => {
    const container = document.createElement('div');
    const overlay = new AdsOverlay(container);

    expect(container.querySelector('.vjs-ads-overlay')).not.toBeNull();
    expect(container.querySelector('.vjs-ads-timer')).not.toBeNull();
    expect(container.querySelector('.vjs-ads-skip')).not.toBeNull();
  });

  it('shows video ad media', () => {
    const container = document.createElement('div');
    const overlay = new AdsOverlay(container);

    overlay.showAd({
      id: 'ad-1', type: 'video', src: '/ad.mp4', mime: 'video/mp4',
      duration: 15, skipAfter: 5,
    });

    const video = container.querySelector('video.vjs-ads-media');
    expect(video).not.toBeNull();
    expect((video as HTMLVideoElement).src).toContain('/ad.mp4');
  });

  it('shows image ad media', () => {
    const container = document.createElement('div');
    const overlay = new AdsOverlay(container);

    overlay.showAd({
      id: 'ad-2', type: 'image', src: '/ad.webp', mime: 'image/webp',
      duration: 5, skipAfter: 3,
    });

    const img = container.querySelector('img.vjs-ads-media');
    expect(img).not.toBeNull();
  });

  it('updates timer display', () => {
    const container = document.createElement('div');
    const overlay = new AdsOverlay(container);

    overlay.updateTimer(5.2, 15);
    const timer = container.querySelector('.vjs-ads-timer');
    expect(timer?.textContent).toContain('0:05');
  });

  it('updates skip button state', () => {
    const container = document.createElement('div');
    const overlay = new AdsOverlay(container);

    overlay.updateSkip(false, 3);
    const skip = container.querySelector('.vjs-ads-skip') as HTMLElement;
    expect(skip.dataset.skipAvailable).toBe('false');
    expect(skip.textContent).toContain('3');

    overlay.updateSkip(true, 0);
    expect(skip.dataset.skipAvailable).toBe('true');
  });

  it('hides overlay', () => {
    const container = document.createElement('div');
    const overlay = new AdsOverlay(container);

    overlay.showAd({
      id: 'ad-1', type: 'video', src: '/ad.mp4', mime: 'video/mp4',
      duration: 15, skipAfter: 5,
    });
    overlay.hide();

    const el = container.querySelector('.vjs-ads-overlay') as HTMLElement;
    expect(el.dataset.adPhase).toBe('hidden');
  });

  it('destroy removes overlay from DOM', () => {
    const container = document.createElement('div');
    const overlay = new AdsOverlay(container);
    overlay.destroy();

    expect(container.querySelector('.vjs-ads-overlay')).toBeNull();
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

```bash
pnpm -F @videojs/ads test
```

- [ ] **Step 3: `ads-overlay.css` 작성**

```css
.vjs-ads-overlay {
  position: absolute;
  inset: 0;
  z-index: 100;
  display: none;
  background: #000;
}

.vjs-ads-overlay[data-ad-phase='playing'] {
  display: flex;
  align-items: center;
  justify-content: center;
}

.vjs-ads-overlay[data-ad-phase='hidden'] {
  display: none;
}

.vjs-ads-media {
  width: 100%;
  height: 100%;
  object-fit: contain;
  cursor: pointer;
}

.vjs-ads-timer {
  position: absolute;
  bottom: 12px;
  left: 12px;
  padding: 4px 10px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.7);
  color: #fff;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
  user-select: none;
}

.vjs-ads-skip {
  position: absolute;
  bottom: 12px;
  right: 12px;
  padding: 6px 14px;
  border: 1px solid rgba(255, 255, 255, 0.5);
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.7);
  color: #fff;
  font-size: 13px;
  cursor: default;
  user-select: none;
  transition: background 0.15s, border-color 0.15s;
}

.vjs-ads-skip[data-skip-available='true'] {
  cursor: pointer;
  border-color: #fff;
}

.vjs-ads-skip[data-skip-available='true']:hover {
  background: rgba(255, 255, 255, 0.2);
}
```

- [ ] **Step 4: `ads-overlay.ts` 구현**

```ts
import type { Ad } from '../core/ads-state';

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export class AdsOverlay {
  #root: HTMLElement;
  #timer: HTMLElement;
  #skip: HTMLElement;
  #mediaContainer: HTMLElement;
  #adMedia: HTMLVideoElement | HTMLImageElement | null = null;
  #onSkip: (() => void) | null = null;
  #destroyed = false;

  constructor(container: HTMLElement) {
    this.#root = document.createElement('div');
    this.#root.className = 'vjs-ads-overlay';
    this.#root.dataset.adPhase = 'hidden';

    this.#mediaContainer = document.createElement('div');
    this.#mediaContainer.style.cssText = 'width:100%;height:100%;display:flex;align-items:center;justify-content:center;';

    this.#timer = document.createElement('div');
    this.#timer.className = 'vjs-ads-timer';
    this.#timer.textContent = 'AD 0:00';

    this.#skip = document.createElement('button');
    this.#skip.className = 'vjs-ads-skip';
    this.#skip.type = 'button';
    this.#skip.dataset.skipAvailable = 'false';
    this.#skip.addEventListener('click', () => {
      if (this.#skip.dataset.skipAvailable === 'true' && this.#onSkip) {
        this.#onSkip();
      }
    });

    this.#root.appendChild(this.#mediaContainer);
    this.#root.appendChild(this.#timer);
    this.#root.appendChild(this.#skip);
    container.appendChild(this.#root);
  }

  showAd(ad: Ad, onClick?: () => void): void {
    this.#clearMedia();

    if (ad.type === 'video') {
      const video = document.createElement('video');
      video.className = 'vjs-ads-media';
      video.src = ad.src;
      video.autoplay = true;
      video.playsInline = true;
      video.muted = false;
      if (onClick) video.addEventListener('click', onClick);
      this.#mediaContainer.appendChild(video);
      this.#adMedia = video;
    } else {
      const img = document.createElement('img');
      img.className = 'vjs-ads-media';
      img.src = ad.src;
      img.alt = 'Advertisement';
      if (onClick) img.addEventListener('click', onClick);
      this.#mediaContainer.appendChild(img);
      this.#adMedia = img;
    }

    this.#root.dataset.adPhase = 'playing';
  }

  updateTimer(currentTime: number, duration: number): void {
    this.#timer.textContent = `AD ${formatTime(currentTime)} / ${formatTime(duration)}`;
  }

  updateSkip(available: boolean, countdown: number): void {
    this.#skip.dataset.skipAvailable = String(available);
    this.#skip.textContent = available ? '광고 건너뛰기 ▶' : `${countdown}초 후 건너뛰기`;
  }

  onSkip(callback: () => void): void {
    this.#onSkip = callback;
  }

  hide(): void {
    this.#clearMedia();
    this.#root.dataset.adPhase = 'hidden';
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#clearMedia();
    this.#root.remove();
  }

  #clearMedia(): void {
    if (this.#adMedia) {
      if (this.#adMedia instanceof HTMLVideoElement) {
        this.#adMedia.pause();
        this.#adMedia.removeAttribute('src');
        this.#adMedia.load();
      }
      this.#adMedia.remove();
      this.#adMedia = null;
    }
  }
}
```

- [ ] **Step 5: 테스트 통과 확인**

```bash
pnpm -F @videojs/ads test
```

- [ ] **Step 6: `src/dom.ts` 업데이트 — 오버레이 수출 추가**

```ts
export { adsFeature } from './dom/ads-feature';
export { AdsOverlay } from './dom/ads-overlay';
export type { MediaAdsState } from './core/ads-state';
export type { Ad, AdPhase } from './core/ads-state';
```

- [ ] **Step 7: 빌드 확인**

```bash
pnpm -F @videojs/ads build
```

- [ ] **Step 8: Commit**

```bash
git add packages/ads/src/dom/
git commit -m "feat(ads): add overlay UI with timer and skip button"
```

---

## Task 5: 샘플 광고 미디어 다운로드

**Files:**
- Create: `packages/sandbox/public/mock/ads.json`
- Create: `packages/sandbox/public/mock/ads/` (미디어 파일)

- [ ] **Step 1: Mock JSON 파일 작성**

`packages/sandbox/public/mock/ads.json`:
```json
{
  "ads": [
    {
      "id": "ad-video-mp4",
      "type": "video",
      "src": "/mock/ads/sample-ad.mp4",
      "mime": "video/mp4",
      "duration": 10,
      "skipAfter": 5,
      "clickUrl": "https://videojs.com",
      "trackingUrl": "/mock/ads/track"
    },
    {
      "id": "ad-video-webm",
      "type": "video",
      "src": "/mock/ads/sample-ad.webm",
      "mime": "video/webm",
      "duration": 10,
      "skipAfter": 5,
      "clickUrl": "https://videojs.com"
    },
    {
      "id": "ad-image-webp",
      "type": "image",
      "src": "/mock/ads/sample-ad.webp",
      "mime": "image/webp",
      "duration": 5,
      "skipAfter": 3,
      "clickUrl": "https://videojs.com"
    },
    {
      "id": "ad-image-gif",
      "type": "image",
      "src": "/mock/ads/sample-ad.gif",
      "mime": "image/gif",
      "duration": 5,
      "skipAfter": 3,
      "clickUrl": "https://videojs.com"
    }
  ]
}
```

- [ ] **Step 2: 웹에서 샘플 광고 미디어 다운로드**

작고 저작권 없는 샘플 파일을 다운로드:
- **mp4**: 짧은 (5-10초) 샘플 비디오
- **webm**: 짧은 샘플 비디오
- **webp**: 배너형 애니메이션 이미지
- **gif**: 배너형 애니메이션 이미지

```bash
mkdir -p packages/sandbox/public/mock/ads
# 각 포맷별 적절한 CC0/Public Domain 샘플 다운로드
```

- [ ] **Step 3: Commit**

```bash
git add packages/sandbox/public/mock/
git commit -m "feat(ads): add mock ad JSON and sample media files"
```

---

## Task 6: Sandbox 통합

**Files:**
- Create: `packages/sandbox/templates/html-video-ads/index.html`
- Create: `packages/sandbox/templates/html-video-ads/main.ts`
- Modify: `packages/sandbox/package.json` — @videojs/ads 의존성 추가
- Modify: `packages/sandbox/vite.config.ts` — optimizeDeps.exclude에 추가
- Modify: `packages/sandbox/app/constants.ts` — PRESETS에 추가
- Modify: `packages/sandbox/app/shell/navbar.tsx` — PRESET_LABELS에 추가
- Modify: `packages/sandbox/app/shell/app.tsx` — 라우트 + 제약 추가

- [ ] **Step 1: sandbox package.json에 의존성 추가**

`@videojs/ads: workspace:*` 를 dependencies에 추가.

- [ ] **Step 2: vite.config.ts optimizeDeps에 추가**

```ts
optimizeDeps: {
  exclude: [
    '@videojs/ads',
    // ... 기존 목록
  ],
},
```

- [ ] **Step 3: constants.ts에 preset 추가**

```ts
export const PRESETS = [
  'video',
  'video-ads',  // 추가
  'hls-video',
  // ...
] as const;
```

- [ ] **Step 4: navbar.tsx에 라벨 추가**

```ts
const PRESET_LABELS: Record<Preset, string> = {
  video: 'Video',
  'video-ads': 'Video + Ads',  // 추가
  // ...
};
```

- [ ] **Step 5: app.tsx에 경로 매핑 추가**

`getPagePath` 함수에서 `video-ads` → `/html-video-ads/` 매핑 추가.

- [ ] **Step 6: 템플릿 index.html 작성**

`packages/sandbox/templates/html-video-ads/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Sandbox — HTML Video + Ads</title>
    <link rel="preconnect" href="https://rsms.me/" />
    <link rel="stylesheet" href="https://rsms.me/inter/inter.css" />
  </head>
  <body class="font-sans">
    <div id="root" class="flex justify-center items-center min-h-screen"></div>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
```

- [ ] **Step 7: 템플릿 main.ts 작성**

`packages/sandbox/templates/html-video-ads/main.ts`:

이 파일은 기존 `html-video/main.ts` 패턴을 따르되, ads feature 를 통합한다:
- `@videojs/ads/dom` 에서 `adsFeature`, `AdsOverlay` import
- `createPlayer`에 `adsFeature` 추가
- `video-player` 렌더링 후 `store.loadAds('/mock/ads.json')` 호출
- store subscribe로 오버레이 업데이트 연결

```ts
import '@app/styles.css';
import '@videojs/html/video/player';
import '@videojs/html/ui/poster';
import { createHtmlSandboxState, createLatestLoader } from '@app/shared/html/sandbox-state';
import { loadVideoSkinTag } from '@app/shared/html/skins';
import { renderStoryboard } from '@app/shared/html/storyboard';
import { onSkinChange, onSourceChange } from '@app/shared/sandbox-listener';
import { getPosterSrc, getStoryboardSrc, SOURCES } from '@app/shared/sources';
import { AdsOverlay } from '@videojs/ads/dom';

const html = String.raw;

const state = createHtmlSandboxState();
const loadLatest = createLatestLoader();

let overlay: AdsOverlay | null = null;

async function render() {
  const tag = await loadLatest(() => loadVideoSkinTag(state.skin, state.styling));
  if (!tag) return;

  const storyboard = getStoryboardSrc(state.source);
  const poster = getPosterSrc(state.source);

  const root = document.getElementById('root')!;
  root.innerHTML = html`
    <div style="position:relative;width:100%;max-width:56rem;margin:0 auto;">
      <video-player>
        <${tag} class="w-full aspect-video">
          <video src="${SOURCES[state.source].url}" playsinline crossorigin="anonymous">
            ${renderStoryboard(storyboard)}
          </video>
          ${poster ? html`<img slot="poster" src="${poster}" alt="Video poster" />` : ''}
        </${tag}>
      </video-player>
    </div>
  `;

  // Setup ads overlay
  const wrapper = root.querySelector('div') as HTMLElement;
  overlay?.destroy();
  overlay = new AdsOverlay(wrapper);

  // Load ads from mock JSON
  loadAndPlayAds(overlay);
}

async function loadAndPlayAds(adsOverlay: AdsOverlay) {
  const response = await fetch('/mock/ads.json');
  const data = await response.json();
  const ads = data.ads;

  if (!ads || ads.length === 0) return;

  // Pick a random ad
  const ad = ads[Math.floor(Math.random() * ads.length)];

  // Find the video element
  const video = document.querySelector('video') as HTMLVideoElement | null;
  if (!video) return;

  // Intercept first play
  let adPlayed = false;
  const originalPlay = video.play.bind(video);

  video.addEventListener('play', function interceptPlay(e) {
    if (adPlayed) return;
    e.preventDefault();
    video.pause();
    adPlayed = true;

    // Show ad overlay
    adsOverlay.showAd(ad, () => {
      if (ad.clickUrl) window.open(ad.clickUrl, '_blank');
    });

    let startTime = performance.now();
    let rafId = 0;

    adsOverlay.onSkip(() => {
      cancelAnimationFrame(rafId);
      adsOverlay.hide();
      video.removeEventListener('play', interceptPlay);
      originalPlay().catch(() => {});
    });

    function tick() {
      const elapsed = (performance.now() - startTime) / 1000;
      adsOverlay.updateTimer(elapsed, ad.duration);
      adsOverlay.updateSkip(
        ad.skipAfter > 0 && elapsed >= ad.skipAfter,
        Math.max(0, Math.ceil(ad.skipAfter - elapsed))
      );

      if (elapsed >= ad.duration) {
        adsOverlay.hide();
        originalPlay().catch(() => {});
        return;
      }

      rafId = requestAnimationFrame(tick);
    }

    rafId = requestAnimationFrame(tick);
  }, { once: false });
}

render();

onSkinChange((skin) => { state.skin = skin; render(); });
onSourceChange((source) => { state.source = source; render(); });
```

- [ ] **Step 8: pnpm install && 빌드 확인**

```bash
pnpm install
pnpm build:packages
```

- [ ] **Step 9: sandbox dev 서버에서 동작 확인**

```bash
pnpm dev:sandbox
# 브라우저에서 Video + Ads preset 선택하여 광고 동작 확인
```

- [ ] **Step 10: Commit**

```bash
git add packages/sandbox/
git commit -m "feat(ads): integrate ads demo in sandbox with mock data"
```

---

## Task 7: 린트 & 타입체크 & 최종 확인

**Files:** 전체

- [ ] **Step 1: 타입체크**

```bash
pnpm typecheck
```

- [ ] **Step 2: 린트**

```bash
pnpm lint
```

- [ ] **Step 3: 린트 에러 수정**

```bash
pnpm lint:fix
```

- [ ] **Step 4: 전체 테스트**

```bash
pnpm -F @videojs/ads test
```

- [ ] **Step 5: sandbox 브라우저 수동 확인**

```bash
pnpm dev:sandbox
```

- 프리셋에서 "Video + Ads" 선택
- 재생 버튼 클릭 → 광고 표시 확인
- 타이머 카운트 확인
- skipAfter 후 건너뛰기 버튼 활성화 확인
- 건너뛰기 클릭 → 콘텐츠 재생 확인
- 광고 완료 → 콘텐츠 자동 재생 확인

- [ ] **Step 6: 최종 Commit**

```bash
git add .
git commit -m "chore(ads): lint and typecheck fixes"
```
