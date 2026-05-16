import '@app/styles.css';
import '@videojs/html/video/player';
import '@videojs/html/ui/poster';
import { createHtmlSandboxState, createLatestLoader } from '@app/shared/html/sandbox-state';
import { loadVideoSkinTag } from '@app/shared/html/skins';
import { renderStoryboard } from '@app/shared/html/storyboard';
import { onSkinChange, onSourceChange } from '@app/shared/sandbox-listener';
import { getPosterSrc, getStoryboardSrc, SOURCES } from '@app/shared/sources';
import type { Ad } from '@videojs/ads';
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

  // Setup ads overlay on the wrapper div
  const wrapper = root.querySelector('div') as HTMLElement;
  overlay?.destroy();
  overlay = new AdsOverlay(wrapper);

  setupPrerollAd(overlay);
}

function setupPrerollAd(adsOverlay: AdsOverlay): void {
  fetch('/mock/ads.json')
    .then((res) => res.json())
    .then((data: { ads?: Ad[] }) => {
      const ads = data.ads;
      if (!ads || ads.length === 0) return;

      // Pick a random ad
      const ad = ads[Math.floor(Math.random() * ads.length)]!;
      attachPreroll(adsOverlay, ad);
    })
    .catch(() => {
      // Ad loading failed — content plays normally
    });
}

function attachPreroll(adsOverlay: AdsOverlay, ad: Ad): void {
  const video = document.querySelector('video');
  if (!video) return;

  let adShown = false;

  video.addEventListener('play', function onFirstPlay() {
    if (adShown) return;
    adShown = true;
    video.removeEventListener('play', onFirstPlay);
    video.pause();

    // Show the ad overlay
    adsOverlay.showAd(ad, () => {
      if (ad.clickUrl) window.open(ad.clickUrl, '_blank');
    });

    adsOverlay.onSkip(() => {
      finishAd();
    });

    const startTime = performance.now();
    let rafId = 0;

    function tick(): void {
      const elapsed = (performance.now() - startTime) / 1000;
      adsOverlay.updateTimer(elapsed, ad.duration);

      const canSkip = ad.skipAfter > 0 && elapsed >= ad.skipAfter;
      const countdown = Math.max(0, Math.ceil(ad.skipAfter - elapsed));
      adsOverlay.updateSkip(canSkip, countdown);

      if (elapsed >= ad.duration) {
        finishAd();
        return;
      }

      rafId = requestAnimationFrame(tick);
    }

    function finishAd(): void {
      cancelAnimationFrame(rafId);
      adsOverlay.hide();
      video!.play().catch(() => {});
    }

    rafId = requestAnimationFrame(tick);
  });
}

render();

onSkinChange((skin) => {
  state.skin = skin;
  render();
});

onSourceChange((source) => {
  state.source = source;
  render();
});
