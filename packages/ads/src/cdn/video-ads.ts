/**
 * Video.js 10 + Ads — integrated CDN bundle.
 *
 * Single file that includes the full Video.js 10 video player (Web Components,
 * default skin, poster) AND the ads overlay system.
 *
 * Usage:
 *   <script type="module" src="video-ads.js"></script>
 *   <script type="module">
 *     import { AdsOverlay, fetchAds, trackAdEvent } from './video-ads.js';
 *   </script>
 *
 *   <video-player>
 *     <video-skin>
 *       <video src="content.mp4" playsinline></video>
 *     </video-skin>
 *   </video-player>
 */

// Video.js 10 player (registers <video-player>, <video-skin>, etc.)
import '@videojs/html/video/player';
import '@videojs/html/video/skin';
import '@videojs/html/ui/poster';

export { fetchAds } from '../core/ads-json-client';
export type { Ad, AdMediaType, AdPhase, AdsResponse, MediaAdsState } from '../core/ads-state';
export { trackAdEvent } from '../core/ads-tracker';
// Ads exports
export { AdsOverlay } from '../dom/ads-overlay';
