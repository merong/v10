// The bundle registers <video-player> and <video-skin> as a side effect, and
// exports the ads helpers. Point this at your own copy when you deploy — see
// the README.
import { AdsOverlay, fetchAds, trackAdEvent } from '../../packages/ads/cdn/video-ads.js';

const ADS_URL = './ads.json';

const container = document.querySelector('.player');
const video = document.querySelector('video');
const overlay = new AdsOverlay(container);

const [ad] = await fetchAds(ADS_URL);

// fetchAds resolves to an empty array on any failure, so a missing or malformed
// ad server means the content plays as if no ad were scheduled.
if (ad) {
  attachPreroll(ad);
}

function attachPreroll(ad) {
  video.addEventListener(
    'play',
    () => {
      video.pause();
      runAd(ad);
    },
    { once: true }
  );
}

function runAd(ad) {
  overlay.showAd(ad, () => {
    trackAdEvent(ad.trackingUrl, 'click');
    if (ad.clickUrl) window.open(ad.clickUrl, '_blank', 'noopener');
  });
  trackAdEvent(ad.trackingUrl, 'impression');

  overlay.onSkip(() => finish('skip'));

  const startedAt = performance.now();
  let frame = 0;

  function tick() {
    const elapsed = (performance.now() - startedAt) / 1000;
    overlay.updateTimer(elapsed, ad.duration);

    // Below skipAfter the overlay renders a countdown instead of a live button.
    const canSkip = ad.skipAfter > 0 && elapsed >= ad.skipAfter;
    overlay.updateSkip(canSkip, Math.max(0, Math.ceil(ad.skipAfter - elapsed)));

    if (elapsed >= ad.duration) {
      finish('complete');
      return;
    }

    frame = requestAnimationFrame(tick);
  }

  function finish(reason) {
    cancelAnimationFrame(frame);
    trackAdEvent(ad.trackingUrl, reason);
    overlay.hide();
    video.play().catch(() => {});
  }

  frame = requestAnimationFrame(tick);
}
