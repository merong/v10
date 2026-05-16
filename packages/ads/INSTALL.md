# Video.js 10 + Ads 설치 가이드

일반 웹페이지 및 CMS(그누보드5 등)에 Video.js 10 플레이어와 광고 시스템을 설치하는 단계별 가이드입니다.

---

## 목차

1. [빌드](#1-빌드)
2. [파일 복사](#2-파일-복사)
3. [일반 웹페이지 설치](#3-일반-웹페이지-설치)
4. [그누보드5 설치](#4-그누보드5-설치)
5. [광고 JSON API 설정](#5-광고-json-api-설정)
6. [설정 옵션](#6-설정-옵션)
7. [API 레퍼런스](#7-api-레퍼런스)
8. [문제 해결](#8-문제-해결)

---

## 1. 빌드

### 사전 요구사항

- Node.js 22.19.0 이상
- pnpm 10.x

### 빌드 실행

```bash
# 저장소 클론 후
cd videojs-v10

# 의존성 설치
pnpm install

# 전체 패키지 빌드 (필수 — ads가 html에 의존)
pnpm build:packages

# 광고 CDN 번들 빌드
pnpm -F @videojs/ads build:cdn
```

### 빌드 결과물

| 파일 | 크기 | 설명 |
|------|------|------|
| `packages/ads/cdn/video-ads.js` | ~110 KB | **통합 번들** — Video.js 10 + 광고 (프로덕션) |
| `packages/ads/cdn/video-ads.dev.js` | ~206 KB | 통합 번들 — 개발용 (디버그 경고 포함) |
| `packages/ads/cdn/videojs-ads.js` | ~3.7 KB | 광고만 — 기존 플레이어에 추가할 때 사용 |
| `packages/html/dist/default/define/video/skin.css` | ~28 KB | 플레이어 스킨 CSS |

---

## 2. 파일 복사

웹 서버의 정적 파일 디렉터리에 다음 파일을 복사합니다.

### 필수 파일

```
your-website/
├── videojs/
│   ├── video-ads.js          ← packages/ads/cdn/video-ads.js
│   └── skin.css              ← packages/html/dist/default/define/video/skin.css
└── mock/                     ← 테스트용 (선택)
    ├── ads.json
    └── ads/
        ├── sample-ad.mp4
        ├── sample-ad.webm
        ├── sample-ad.webp
        └── sample-ad.gif
```

### 복사 명령어 예시

```bash
# 대상 디렉터리 생성
mkdir -p /var/www/html/videojs

# 통합 번들 (JS)
cp packages/ads/cdn/video-ads.js /var/www/html/videojs/

# 스킨 CSS
cp packages/html/dist/default/define/video/skin.css /var/www/html/videojs/

# 테스트용 mock 데이터 (선택)
cp -r packages/sandbox/public/mock /var/www/html/
```

---

## 3. 일반 웹페이지 설치

### Step 1: HTML 기본 구조

```html
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>동영상 페이지</title>

  <!-- Step 1: Video.js 스킨 CSS 로드 -->
  <link rel="stylesheet" href="/videojs/skin.css">

  <style>
    /* 플레이어 컨테이너 — 반드시 position:relative 필요 (광고 오버레이 기준점) */
    .player-wrapper {
      position: relative;
      width: 100%;
      max-width: 800px;
      margin: 0 auto;
    }
  </style>
</head>
<body>

  <!-- Step 2: 플레이어 마크업 -->
  <div class="player-wrapper" id="player-wrapper">
    <video-player>
      <video-skin style="aspect-ratio: 16/9;">
        <video
          src="https://example.com/content.mp4"
          playsinline
          crossorigin="anonymous"
        ></video>
      </video-skin>
    </video-player>
  </div>

  <!-- Step 3: 통합 번들 로드 (Video.js 10 + 광고) -->
  <script type="module">
    import { AdsOverlay, fetchAds, trackAdEvent } from '/videojs/video-ads.js';

    const wrapper = document.getElementById('player-wrapper');
    const video = document.querySelector('video');

    // Step 4: 광고 오버레이 생성
    const overlay = new AdsOverlay(wrapper);

    // Step 5: 광고 데이터 로딩
    const ads = await fetchAds('/api/ads.json');

    if (ads.length > 0) {
      // Step 6: 프리롤 광고 설정
      const ad = ads[Math.floor(Math.random() * ads.length)];
      let adPlayed = false;

      video.addEventListener('play', function onPlay() {
        if (adPlayed) return;
        adPlayed = true;
        video.removeEventListener('play', onPlay);
        video.pause();

        // 광고 표시
        overlay.showAd(ad, () => {
          trackAdEvent(ad.trackingUrl, 'click', { adId: ad.id });
          if (ad.clickUrl) window.open(ad.clickUrl, '_blank');
        });

        // 노출 트래킹
        trackAdEvent(ad.trackingUrl, 'impression', { adId: ad.id });

        // 스킵 핸들러
        overlay.onSkip(() => {
          trackAdEvent(ad.trackingUrl, 'skip', { adId: ad.id });
          finish();
        });

        // 타이머 루프
        const start = performance.now();
        let raf = 0;

        function tick() {
          const elapsed = (performance.now() - start) / 1000;
          overlay.updateTimer(elapsed, ad.duration);

          const canSkip = ad.skipAfter > 0 && elapsed >= ad.skipAfter;
          overlay.updateSkip(canSkip, Math.max(0, Math.ceil(ad.skipAfter - elapsed)));

          if (elapsed >= ad.duration) {
            trackAdEvent(ad.trackingUrl, 'complete', { adId: ad.id });
            finish();
            return;
          }
          raf = requestAnimationFrame(tick);
        }

        function finish() {
          cancelAnimationFrame(raf);
          overlay.hide();
          video.play().catch(() => {});
        }

        raf = requestAnimationFrame(tick);
      });
    }
  </script>

</body>
</html>
```

### Step 2: 동작 확인 체크리스트

- [ ] 페이지 로드 시 플레이어가 표시되는가
- [ ] 재생 버튼 클릭 시 광고가 먼저 표시되는가
- [ ] 광고 좌하단에 타이머(`AD 0:03 / 0:10`)가 표시되는가
- [ ] `skipAfter` 시간 후 우하단 스킵 버튼이 활성화되는가
- [ ] 스킵 클릭 시 광고가 닫히고 콘텐츠가 재생되는가
- [ ] 광고 완료 후 자동으로 콘텐츠가 재생되는가
- [ ] 두 번째 재생부터는 광고 없이 바로 재생되는가

---

## 4. 그누보드5 설치

### Step 1: 파일 배치

그누보드5 루트 디렉터리 기준:

```
gnuboard5/
├── videojs/                    ← 새로 생성
│   ├── video-ads.js
│   └── skin.css
├── api/                        ← 광고 API (새로 생성)
│   └── ads.php
└── skin/
    └── board/
        └── your-skin/          ← 게시판 스킨
            └── view.skin.php   ← 수정 대상
```

```bash
# 그누보드5 루트에 videojs 디렉터리 생성
mkdir -p /path/to/gnuboard5/videojs

# 파일 복사
cp packages/ads/cdn/video-ads.js /path/to/gnuboard5/videojs/
cp packages/html/dist/default/define/video/skin.css /path/to/gnuboard5/videojs/
```

### Step 2: 게시판 스킨 수정 (`view.skin.php`)

동영상 게시판의 `view.skin.php`에서 동영상이 표시되는 부분을 수정합니다.

```php
<?php
// view.skin.php 상단에 CSS 추가
add_stylesheet('<link rel="stylesheet" href="'.G5_URL.'/videojs/skin.css">', 0);
?>

<!-- 기존 동영상 영역을 아래로 교체 -->
<?php if ($video_url): // 동영상 URL이 있는 경우 ?>
<div class="player-wrapper" id="player-wrapper-<?php echo $bo_table; ?>-<?php echo $wr_id; ?>"
     style="position:relative;width:100%;max-width:800px;margin:0 auto;">
  <video-player>
    <video-skin style="aspect-ratio:16/9;">
      <video
        src="<?php echo $video_url; ?>"
        playsinline
        crossorigin="anonymous"
      ></video>
    </video-skin>
  </video-player>
</div>

<script type="module">
  import { AdsOverlay, fetchAds, trackAdEvent } from '<?php echo G5_URL; ?>/videojs/video-ads.js';

  (async () => {
    const wrapperId = 'player-wrapper-<?php echo $bo_table; ?>-<?php echo $wr_id; ?>';
    const wrapper = document.getElementById(wrapperId);
    const video = wrapper.querySelector('video');
    if (!wrapper || !video) return;

    const overlay = new AdsOverlay(wrapper);
    const ads = await fetchAds('<?php echo G5_URL; ?>/api/ads.php?bo_table=<?php echo $bo_table; ?>');

    if (ads.length > 0) {
      const ad = ads[Math.floor(Math.random() * ads.length)];
      let adPlayed = false;

      video.addEventListener('play', function onPlay() {
        if (adPlayed) return;
        adPlayed = true;
        video.removeEventListener('play', onPlay);
        video.pause();

        overlay.showAd(ad, () => {
          trackAdEvent(ad.trackingUrl, 'click', { adId: ad.id });
          if (ad.clickUrl) window.open(ad.clickUrl, '_blank');
        });

        trackAdEvent(ad.trackingUrl, 'impression', { adId: ad.id });

        overlay.onSkip(() => {
          trackAdEvent(ad.trackingUrl, 'skip', { adId: ad.id });
          finish();
        });

        const start = performance.now();
        let raf = 0;

        function tick() {
          const elapsed = (performance.now() - start) / 1000;
          overlay.updateTimer(elapsed, ad.duration);
          const canSkip = ad.skipAfter > 0 && elapsed >= ad.skipAfter;
          overlay.updateSkip(canSkip, Math.max(0, Math.ceil(ad.skipAfter - elapsed)));
          if (elapsed >= ad.duration) {
            trackAdEvent(ad.trackingUrl, 'complete', { adId: ad.id });
            finish();
            return;
          }
          raf = requestAnimationFrame(tick);
        }

        function finish() {
          cancelAnimationFrame(raf);
          overlay.hide();
          video.play().catch(() => {});
        }

        raf = requestAnimationFrame(tick);
      });
    }
  })();
</script>
<?php endif; ?>
```

### Step 3: 광고 API 생성 (`api/ads.php`)

```php
<?php
include_once('./_common.php');

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');

// 게시판별 광고 필터링 (선택)
$bo_table = isset($_GET['bo_table']) ? clean_xss_tags($_GET['bo_table']) : '';

// DB에서 활성 광고 조회
// 예시: g5_ads 테이블 (직접 생성 필요)
$ads = array();

$sql = "SELECT * FROM {$g5['table_prefix']}ads
        WHERE ad_status = 'active'
        AND (ad_start_date IS NULL OR ad_start_date <= NOW())
        AND (ad_end_date IS NULL OR ad_end_date >= NOW())
        ORDER BY ad_order ASC";

$result = sql_query($sql, false);

if ($result) {
    while ($row = sql_fetch_array($result)) {
        $ad = array(
            'id'          => 'ad-' . $row['ad_id'],
            'type'        => $row['ad_type'],        // 'video' 또는 'image'
            'src'         => G5_URL . '/data/ads/' . $row['ad_file'],
            'mime'        => $row['ad_mime'],         // 'video/mp4', 'image/webp' 등
            'duration'    => (int) $row['ad_duration'],
            'skipAfter'   => (int) $row['ad_skip_after'],
            'clickUrl'    => $row['ad_click_url'] ?: null,
            'trackingUrl' => G5_URL . '/api/ads_track.php',
        );
        $ads[] = $ad;
    }
}

// 광고가 없으면 빈 배열 반환 (콘텐츠 정상 재생)
echo json_encode(array('ads' => $ads), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
exit;
```

### Step 4: 광고 트래킹 API (`api/ads_track.php`)

```php
<?php
include_once('./_common.php');

header('Content-Type: application/json; charset=utf-8');

$input = json_decode(file_get_contents('php://input'), true);
if (!$input || !isset($input['event'])) {
    http_response_code(400);
    echo json_encode(['error' => 'invalid request']);
    exit;
}

$event = clean_xss_tags($input['event']);    // impression, complete, skip, click
$adId  = clean_xss_tags($input['adId'] ?? '');
$time  = isset($input['time']) ? (float) $input['time'] : null;

// DB에 트래킹 이벤트 기록
$sql = "INSERT INTO {$g5['table_prefix']}ads_tracking
        SET at_ad_id = '{$adId}',
            at_event = '{$event}',
            at_time = " . ($time !== null ? "'{$time}'" : "NULL") . ",
            at_ip = '{$_SERVER['REMOTE_ADDR']}',
            at_datetime = NOW()";
sql_query($sql, false);

echo json_encode(['ok' => true]);
exit;
```

### Step 5: DB 테이블 생성

```sql
-- 광고 관리 테이블
CREATE TABLE IF NOT EXISTS g5_ads (
  ad_id         INT AUTO_INCREMENT PRIMARY KEY,
  ad_type       ENUM('video', 'image') NOT NULL DEFAULT 'video',
  ad_file       VARCHAR(255) NOT NULL COMMENT '파일명 (data/ads/ 하위)',
  ad_mime       VARCHAR(50) NOT NULL COMMENT 'MIME 타입',
  ad_duration   INT NOT NULL DEFAULT 10 COMMENT '광고 표시 시간(초)',
  ad_skip_after INT NOT NULL DEFAULT 5 COMMENT 'N초 후 스킵 가능 (0=불가)',
  ad_click_url  VARCHAR(500) DEFAULT NULL COMMENT '클릭 시 이동 URL',
  ad_status     ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
  ad_order      INT NOT NULL DEFAULT 0 COMMENT '표시 순서',
  ad_start_date DATETIME DEFAULT NULL COMMENT '시작일 (NULL=즉시)',
  ad_end_date   DATETIME DEFAULT NULL COMMENT '종료일 (NULL=무기한)',
  ad_created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_status_date (ad_status, ad_start_date, ad_end_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='동영상 광고 관리';

-- 광고 트래킹 테이블
CREATE TABLE IF NOT EXISTS g5_ads_tracking (
  at_id       BIGINT AUTO_INCREMENT PRIMARY KEY,
  at_ad_id    VARCHAR(50) NOT NULL,
  at_event    ENUM('impression', 'complete', 'skip', 'click') NOT NULL,
  at_time     DECIMAL(10,2) DEFAULT NULL COMMENT '스킵 시점(초)',
  at_ip       VARCHAR(45) NOT NULL,
  at_datetime DATETIME NOT NULL,
  INDEX idx_ad_event (at_ad_id, at_event),
  INDEX idx_datetime (at_datetime)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='광고 트래킹 로그';
```

### Step 6: 광고 파일 업로드 디렉터리

```bash
mkdir -p /path/to/gnuboard5/data/ads
chmod 755 /path/to/gnuboard5/data/ads
```

관리자가 광고 파일(mp4, webm, webp, gif)을 이 디렉터리에 업로드합니다.

### Step 7: 광고 등록 예시

```sql
-- MP4 비디오 광고 (10초, 5초 후 스킵)
INSERT INTO g5_ads (ad_type, ad_file, ad_mime, ad_duration, ad_skip_after, ad_click_url)
VALUES ('video', 'promo-spring.mp4', 'video/mp4', 10, 5, 'https://shop.example.com/spring-sale');

-- WebP 이미지 광고 (5초, 3초 후 스킵)
INSERT INTO g5_ads (ad_type, ad_file, ad_mime, ad_duration, ad_skip_after, ad_click_url)
VALUES ('image', 'banner-event.webp', 'image/webp', 5, 3, 'https://shop.example.com/event');

-- 스킵 불가능한 광고 (skipAfter = 0)
INSERT INTO g5_ads (ad_type, ad_file, ad_mime, ad_duration, ad_skip_after, ad_click_url)
VALUES ('video', 'important-notice.mp4', 'video/mp4', 5, 0, NULL);
```

---

## 5. 광고 JSON API 설정

### 요청

```
GET /api/ads.php?bo_table=video
```

### 응답 형식

```json
{
  "ads": [
    {
      "id": "ad-1",
      "type": "video",
      "src": "/data/ads/promo.mp4",
      "mime": "video/mp4",
      "duration": 10,
      "skipAfter": 5,
      "clickUrl": "https://example.com/landing",
      "trackingUrl": "/api/ads_track.php"
    }
  ]
}
```

### 필드 설명

| 필드 | 타입 | 필수 | 설명 |
|------|------|------|------|
| `id` | string | O | 광고 고유 ID |
| `type` | `"video"` \| `"image"` | O | 미디어 유형 |
| `src` | string | O | 미디어 파일 URL |
| `mime` | string | O | MIME 타입 |
| `duration` | number | O | 광고 표시 시간 (초) |
| `skipAfter` | number | O | N초 후 스킵 가능 (0 = 스킵 불가) |
| `clickUrl` | string | X | 클릭 시 이동 URL |
| `trackingUrl` | string | X | 트래킹 이벤트 전송 URL |

### 지원 미디어 형식

| 형식 | type | mime | 표시 방식 |
|------|------|------|-----------|
| MP4 | `video` | `video/mp4` | `<video>` autoplay |
| WebM | `video` | `video/webm` | `<video>` autoplay |
| WebP (animated) | `image` | `image/webp` | `<img>` + duration 타이머 |
| GIF (animated) | `image` | `image/gif` | `<img>` + duration 타이머 |

---

## 6. 설정 옵션

### 스킵 동작

| `skipAfter` 값 | 동작 |
|-----------------|------|
| `0` | 스킵 불가 — 광고를 끝까지 봐야 함 |
| `3` | 3초 후 "광고 건너뛰기" 버튼 활성화 |
| `5` | 5초 후 "광고 건너뛰기" 버튼 활성화 |

### 트래킹 이벤트

| 이벤트 | 시점 | 페이로드 |
|--------|------|----------|
| `impression` | 광고 표시 시작 | `{ event, adId }` |
| `complete` | 광고 완료 (끝까지 시청) | `{ event, adId }` |
| `skip` | 사용자 건너뛰기 | `{ event, adId, time }` |
| `click` | 광고 클릭 | `{ event, adId }` |

### 다중 플레이어 지원

한 페이지에 여러 동영상이 있는 경우, 각각 별도의 `AdsOverlay`를 생성합니다:

```js
document.querySelectorAll('.player-wrapper').forEach(async (wrapper) => {
  const video = wrapper.querySelector('video');
  const overlay = new AdsOverlay(wrapper);
  const ads = await fetchAds('/api/ads.json');
  // ... 각 플레이어별 프리롤 설정
});
```

---

## 7. API 레퍼런스

### `fetchAds(url, signal?): Promise<Ad[]>`

```js
// 기본 사용
const ads = await fetchAds('/api/ads.json');

// 5초 타임아웃
const controller = new AbortController();
setTimeout(() => controller.abort(), 5000);
const ads = await fetchAds('/api/ads.json', controller.signal);

// 에러 시 빈 배열 반환 (콘텐츠 정상 재생)
```

### `AdsOverlay`

```js
const overlay = new AdsOverlay(containerElement);

overlay.showAd(ad, onClickCallback);           // 광고 표시
overlay.updateTimer(currentSec, totalSec);      // 타이머 업데이트
overlay.updateSkip(isAvailable, countdown);     // 스킵 버튼 상태
overlay.onSkip(callback);                       // 스킵 클릭 핸들러
overlay.hide();                                 // 오버레이 숨김
overlay.destroy();                              // DOM 제거
```

### `trackAdEvent(url, event, extra?): void`

```js
trackAdEvent('/api/ads_track.php', 'impression', { adId: 'ad-1' });
trackAdEvent('/api/ads_track.php', 'skip', { adId: 'ad-1', time: 5.2 });
// fire-and-forget — 실패해도 무시
```

---

## 8. 문제 해결

### 플레이어가 표시되지 않음

- `video-ads.js` 경로가 올바른지 확인
- 브라우저 콘솔에서 404 에러 확인
- `<script type="module">`인지 확인 (ES 모듈)

### 광고가 표시되지 않음

- `/api/ads.json` 또는 `/api/ads.php` 응답이 올바른 JSON인지 확인
- 브라우저 콘솔에서 `fetchAds` 결과 확인: `console.log(ads)`
- 광고 미디어 파일 URL이 접근 가능한지 확인
- CORS 문제가 있다면 서버에서 `Access-Control-Allow-Origin` 헤더 추가

### 광고 오버레이가 플레이어 뒤에 숨겨짐

- 플레이어 컨테이너에 `position: relative` 확인
- 다른 요소의 `z-index`가 100 이상이면 충돌할 수 있음

### 광고 비디오가 자동 재생되지 않음

- 브라우저 자동재생 정책 — 사용자 상호작용(재생 클릭) 후에만 광고 비디오가 재생됨
- 프리롤 방식은 사용자가 재생 버튼을 클릭한 후 동작하므로 대부분 문제없음

### 그누보드5에서 `<script type="module">` 충돌

- 그누보드5의 jQuery와 ES 모듈은 서로 영향을 주지 않음
- `type="module"`은 자동으로 `defer`이므로 DOM 로드 후 실행됨

### IE/구형 브라우저 지원

- ES2022 문법 사용 — Chrome 80+, Firefox 80+, Safari 14+, Edge 80+
- IE 지원 불가. 구형 브라우저는 광고 없이 기본 `<video>` 재생으로 폴백됨
