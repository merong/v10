/**
 * Preroll lifecycle, shared by all three pages.
 *
 * This is a classic script rather than a module so `iife.html` can stay free of
 * `type="module"` entirely. The three pages differ only in how they obtain the
 * helpers; what happens to the ad afterwards is identical, and lives here.
 */
globalThis.startPreroll = function startPreroll(helpers, options) {
  const { AdsOverlay, fetchAds, trackAdEvent } = helpers;
  const { adsUrl = './ads.json' } = options ?? {};

  const container = document.querySelector('.player');
  const video = document.querySelector('video');
  const overlay = new AdsOverlay(container);

  // `?ad=image-preroll` picks an entry by id so either media type can be
  // checked directly. Without it the first ad in the list runs.
  const wanted = new URLSearchParams(location.search).get('ad');

  fetchAds(adsUrl).then((ads) => {
    // fetchAds resolves to an empty array on any failure, so a missing or
    // malformed ad server means the content plays as if none were scheduled.
    const ad = ads.find((candidate) => candidate.id === wanted) ?? ads[0];
    if (!ad) return;

    showAdLabel(ad);
    video.addEventListener('play', () => runAd(ad), { once: true });
  });

  function runAd(ad) {
    video.pause();

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

  function showAdLabel(ad) {
    const label = document.querySelector('[data-ad-label]');
    if (label) {
      label.textContent = `${ad.type} ad · ${ad.duration}s · skippable after ${ad.skipAfter}s`;
    }
  }
};
