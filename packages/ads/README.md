# @videojs/ads

Video.js 10용 프리롤 광고 프레임워크. JSON API 기반으로 자체 광고를 관리하고, 콘텐츠 재생 전 프리롤 형태로 제공합니다.

## 아키텍처

```
@videojs/ads
├── core/              # 런타임 비의존 로직
│   ├── ads-state.ts        # 타입 정의 (Ad, AdPhase, MediaAdsState)
│   ├── ads-json-client.ts  # JSON API fetch 클라이언트
│   └── ads-tracker.ts      # 광고 트래킹 이벤트 전송
└── dom/               # DOM 전용 로직
    ├── ads-feature.ts      # Feature Slice (상태 머신 + store 연동)
    ├── ads-overlay.ts      # 오버레이 UI (타이머, 스킵 버튼, 미디어)
    └── ads-overlay.css     # 오버레이 스타일 (인라인 주입)
```

### 의존성 계층

```
@videojs/utils ← @videojs/store ← @videojs/ads
```

`@videojs/core`에 의존하지 않으므로 순환 참조 없이 독립적으로 사용할 수 있습니다.

## 상태 머신

```
idle → loading → ready → playing → done
                            ↓
                        skipped → done

error (어느 단계에서든 발생 가능)
```

| 상태 | 설명 |
|------|------|
| `idle` | 초기 상태, 광고 미로드 |
| `loading` | JSON API에서 광고 데이터 로딩 중 |
| `ready` | 광고 로드 완료, 재생 대기 |
| `playing` | 광고 재생 중 (타이머 동작) |
| `skipped` | 사용자가 광고 건너뛰기 |
| `done` | 광고 완료 또는 스킵, 콘텐츠 재생 재개 |
| `error` | 광고 로딩 실패 (콘텐츠 정상 재생) |

## JSON API 스펙

### 요청

```
GET /api/ads?context=preroll&content_id=xxx
```

### 응답

```json
{
  "ads": [
    {
      "id": "ad-001",
      "type": "video",
      "src": "https://example.com/ads/promo.mp4",
      "mime": "video/mp4",
      "duration": 15,
      "skipAfter": 5,
      "clickUrl": "https://example.com/landing",
      "trackingUrl": "https://example.com/api/ads/track"
    }
  ]
}
```

### 필드 설명

| 필드 | 타입 | 필수 | 설명 |
|------|------|------|------|
| `id` | string | O | 광고 고유 식별자 |
| `type` | `'video'` \| `'image'` | O | 미디어 유형 |
| `src` | string | O | 미디어 URL |
| `mime` | string | O | MIME 타입 (`video/mp4`, `video/webm`, `image/webp`, `image/gif`) |
| `duration` | number | O | 광고 표시 시간 (초) |
| `skipAfter` | number | O | N초 후 건너뛰기 가능 (0이면 스킵 불가) |
| `clickUrl` | string | X | 클릭 시 이동할 URL |
| `trackingUrl` | string | X | 트래킹 이벤트 전송 URL |

## 트래킹 이벤트

`trackingUrl`이 설정된 경우, 다음 이벤트를 POST로 전송합니다 (fire-and-forget):

| 이벤트 | 시점 | 페이로드 |
|--------|------|----------|
| `impression` | 광고 재생 시작 | `{ event: 'impression', adId }` |
| `complete` | 광고 재생 완료 | `{ event: 'complete', adId }` |
| `skip` | 사용자 건너뛰기 | `{ event: 'skip', adId, time }` |
| `click` | 광고 클릭 | `{ event: 'click', adId }` |

## 주요 API

### `fetchAds(url, signal?): Promise<Ad[]>`

JSON API에서 광고 데이터를 가져옵니다. 응답 검증 후 유효한 광고만 반환합니다. 네트워크 에러 시 빈 배열을 반환합니다 (광고 실패가 콘텐츠를 막지 않음).

### `trackAdEvent(url, event, extra?): void`

트래킹 이벤트를 전송합니다. `keepalive: true`로 페이지 이탈 시에도 전송을 보장합니다. 실패해도 무시합니다.

### `adsFeature` (Feature Slice)

Video.js 10의 `defineSlice<AdsTarget>()` 패턴으로 구현된 Feature Slice입니다.

**State:**

```ts
interface MediaAdsState {
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

**동작:**
- `loadAds(url)` — JSON API 호출 → 파싱 → `ready` 상태 전환
- `attach()` — media `play` 이벤트 감지 → `ready`면 콘텐츠 pause → 광고 타이머 시작
- `skipAd()` — 트래킹 전송 → `done` 상태 → 콘텐츠 재생 재개

### `AdsOverlay` 클래스

콘텐츠 플레이어 위에 오버레이되는 광고 UI를 관리합니다.

```ts
const overlay = new AdsOverlay(containerElement);

overlay.showAd(ad, onClick?);       // 광고 미디어 표시 (video 또는 image)
overlay.updateTimer(current, total); // 타이머 텍스트 업데이트
overlay.updateSkip(available, countdown); // 스킵 버튼 상태 업데이트
overlay.onSkip(callback);           // 스킵 클릭 핸들러 등록
overlay.hide();                     // 오버레이 숨김
overlay.destroy();                  // DOM에서 제거 (idempotent)
```

**UI 구성:**

```
┌─────────────────────────────────────────┐
│  [광고 미디어 - video/image 전체 덮기]    │
│                                         │
│  ┌────────────────┐    ┌──────────────┐ │
│  │ AD 0:05 / 0:15 │    │ 3초 후       │ │
│  │                │    │ 건너뛰기     │ │
│  └────────────────┘    └──────────────┘ │
└─────────────────────────────────────────┘
```

- 타이머 배지: 좌하단, `AD {경과} / {전체}` 형식
- 스킵 버튼: 우하단, `skipAfter` 전까지 카운트다운 표시, 이후 클릭 가능
- CSS는 `<style>` 태그로 자동 주입 (별도 CSS 임포트 불필요)

## 사용법

### Standalone (오버레이 직접 사용)

```ts
import type { Ad } from '@videojs/ads';
import { AdsOverlay } from '@videojs/ads/dom';

const overlay = new AdsOverlay(playerWrapper);

const response = await fetch('/api/ads');
const { ads } = await response.json();
const ad = ads[0];

// 재생 인터셉트
video.addEventListener('play', () => {
  video.pause();
  overlay.showAd(ad);
  overlay.onSkip(() => { overlay.hide(); video.play(); });
  // ... rAF 타이머 루프
});
```

### Video.js 10 Feature Slice로 사용

```ts
import { videoFeatures } from '@videojs/core/dom';
import { createPlayer } from '@videojs/html';
import { adsFeature } from '@videojs/ads/dom';

const { ProviderMixin, ContainerMixin } = createPlayer({
  features: [...videoFeatures, adsFeature],
});

// store에서 광고 로딩
store.state.loadAds('/api/ads?context=preroll');
```

## 지원 미디어 형식

| 형식 | type | 표시 방식 |
|------|------|-----------|
| MP4 | `video` | `<video>` 엘리먼트, autoplay |
| WebM | `video` | `<video>` 엘리먼트, autoplay |
| WebP | `image` | `<img>` 엘리먼트, duration 타이머 |
| GIF | `image` | `<img>` 엘리먼트, duration 타이머 |

## 테스트

```bash
# 전체 테스트 실행
pnpm -F @videojs/ads test

# 감시 모드
pnpm -F @videojs/ads test:watch
```

22개 테스트 (4개 파일):
- `ads-json-client.test.ts` — JSON 파싱, 에러 처리, 필터링 (5개)
- `ads-tracker.test.ts` — POST 전송, undefined URL 처리 (2개)
- `ads-feature.test.ts` — 초기 상태, loadAds 전환, skipAd (6개)
- `ads-overlay.test.ts` — DOM 생성, 미디어, 타이머, 스킵, 정리 (9개)

## Sandbox 데모

```bash
pnpm dev:sandbox
```

브라우저에서 Preset 드롭다운 → **Video + Ads** 선택. Mock 광고 데이터(`/mock/ads.json`)로 프리롤 광고가 동작합니다.

## 설계 결정

### videojs-contrib-ads와의 관계

기존 Video.js 7/8의 `videojs-contrib-ads`를 참고하여 설계했으나, v10의 Feature Slice 아키텍처에 맞게 재구현했습니다.

| contrib-ads | @videojs/ads |
|-------------|-------------|
| Plugin 시스템 | Feature Slice (`defineSlice`) |
| 복잡한 상태 머신 (11개 상태) | 단순화된 상태 머신 (7개 상태) |
| 이벤트 재분배 (ad*/content*) | 직접 media 이벤트 인터셉트 |
| Snapshot/Restore | 불필요 (별도 video 엘리먼트 사용) |
| VAST/IMA 통합 | JSON API 자체 광고 |

### core/dom 분리

v10의 패턴을 따라 런타임 비의존 로직(`core/`)과 DOM 전용 로직(`dom/`)을 분리했습니다. 타입과 JSON 클라이언트는 어떤 환경에서든 사용 가능합니다.

### CSS 인라인 주입

별도 CSS 파일 임포트 없이 `AdsOverlay` 생성 시 `<style>` 태그를 자동 주입합니다. 중복 주입을 방지하기 위해 ID 기반 체크를 수행합니다.

## 향후 확장 가능 영역

- **미드롤/포스트롤** — 상태 머신에 midroll/postroll 상태 추가
- **VAST/IMA 어댑터** — JSON 클라이언트를 VAST 파서로 교체
- **Stitched Ads (SSAI)** — 서버 사이드 광고 삽입 지원
- **React 컴포넌트** — React 바인딩 (`useAds` hook)
- **Privacy (TCF/CCPA)** — 동의 프레임워크 통합
- **다중 광고** — 광고 Pod (여러 광고 연속 재생)
