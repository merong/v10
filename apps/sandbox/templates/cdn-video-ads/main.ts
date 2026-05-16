/**
 * CDN Video + Ads demo — single bundle integration test.
 *
 * Uses `@videojs/ads/cdn/video-ads` which bundles:
 * - Video.js 10 player (Web Components, default skin, poster)
 * - Ads overlay (AdsOverlay, fetchAds, trackAdEvent)
 */

// Single import — player + ads in one bundle
import { AdsOverlay, fetchAds, trackAdEvent } from '@videojs/ads/cdn/video-ads';

const html = String.raw;

const root = document.getElementById('root')!;
root.innerHTML = html`
  <div id="wrapper" style="position:relative;width:100%;max-width:56rem;margin:0 auto;">
    <video-player>
      <video-skin class="aspect-video">
        <video
          src="https://stream.mux.com/VcmKA6aqzIzlg3MayLJDnbF55kX00mds028Z65QxvBYaA/high.mp4"
          playsinline
          crossorigin="anonymous"
        ></video>
      </video-skin>
    </video-player>
  </div>
`;

const wrapper = document.getElementById('wrapper')!;
const video = document.querySelector('video')!;
const overlay = new AdsOverlay(wrapper);

// Load ads and set up preroll
const ads = await fetchAds('/mock/ads.json');

if (ads.length > 0) {
  const ad = ads[Math.floor(Math.random() * ads.length)]!;
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
