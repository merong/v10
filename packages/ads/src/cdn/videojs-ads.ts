/**
 * The ads half on its own, for a page that already loads a player.
 *
 * Registers `<media-ads>`; link `ads-overlay.css` alongside it.
 *
 *   <link rel="stylesheet" href="ads-overlay.css" />
 *   <script type="module" src="videojs-ads.js"></script>
 *
 *   <video-player>
 *     <video-skin>
 *       <video src="/video.mp4" playsinline></video>
 *       <media-ads src="/ads.json"></media-ads>
 *     </video-skin>
 *   </video-player>
 *
 * The exports below are for driving the overlay by hand instead.
 */
import '../define/media-ads';

export { fetchAds } from '../core/ads-json-client';
export type { Ad, AdMediaType, AdPhase, AdsResponse, MediaAdsState } from '../core/ads-state';
export { trackAdEvent } from '../core/ads-tracker';
export type { AdsOverlayLabels, AdsOverlayOptions } from '../dom/ads-overlay';
export { AdsOverlay } from '../dom/ads-overlay';
