import { defineSlice } from '@videojs/store';
import { fetchAds } from '../core/ads-json-client';
import type { Ad, MediaAdsState } from '../core/ads-state';
import { trackAdEvent } from '../core/ads-tracker';

interface AdsTarget {
  media: HTMLVideoElement;
  container: HTMLElement | null;
}

export const adsFeature = defineSlice<AdsTarget>()({
  name: 'ads',
  state: ({ signals, set }): MediaAdsState => {
    let ads: Ad[] = [];

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

        const ad = ads[0]!;
        set({ adPhase: 'ready', currentAd: ad, adDuration: ad.duration });
      },

      skipAd() {
        const ad = ads[0];
        if (!ad) return;

        trackAdEvent(ad.trackingUrl, 'skip', { adId: ad.id });
        set({
          adPhase: 'done',
          skipAvailable: false,
          skipCountdown: 0,
        });
      },
    };
  },

  attach({ target, signal, get, set }) {
    const { media } = target;
    let rafId = 0;
    let adStartTimestamp = 0;

    function cleanup(): void {
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      adStartTimestamp = 0;
    }

    function updateAdTime(): void {
      const state = get();
      if (state.adPhase !== 'playing' || !state.currentAd) {
        cleanup();
        return;
      }

      const ad = state.currentAd;
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
        cleanup();
        set({ adPhase: 'done', adCurrentTime: ad.duration, skipAvailable: false, skipCountdown: 0 });
        media.play().catch(() => {});
        return;
      }

      rafId = requestAnimationFrame(updateAdTime);
    }

    function onPlay(): void {
      const state = get();
      if (state.adPhase !== 'ready' || !state.currentAd) return;

      media.pause();

      const ad = state.currentAd;
      adStartTimestamp = performance.now();

      set({
        adPhase: 'playing',
        adCurrentTime: 0,
        skipAvailable: ad.skipAfter <= 0,
        skipCountdown: ad.skipAfter > 0 ? ad.skipAfter : 0,
      });

      trackAdEvent(ad.trackingUrl, 'impression', { adId: ad.id });
      rafId = requestAnimationFrame(updateAdTime);
    }

    media.addEventListener('play', onPlay, { signal });

    signal.addEventListener('abort', cleanup, { once: true });
  },
});
