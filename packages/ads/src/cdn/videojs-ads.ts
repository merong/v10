/**
 * @videojs/ads CDN bundle entry point.
 *
 * Self-contained bundle — includes overlay UI, JSON client, and tracker.
 * CSS is auto-injected via <style> tag on first AdsOverlay instantiation.
 *
 * Usage:
 *   <script type="module" src="videojs-ads.js"></script>
 *   <script type="module">
 *     import { AdsOverlay, fetchAds, trackAdEvent } from './videojs-ads.js';
 *   </script>
 */

export { fetchAds } from '../core/ads-json-client';
export type { Ad, AdMediaType, AdPhase, AdsResponse, MediaAdsState } from '../core/ads-state';
export { trackAdEvent } from '../core/ads-tracker';
export { AdsOverlay } from '../dom/ads-overlay';
