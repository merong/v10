# Preroll ad example

The same skippable preroll, loaded three ways. Plain HTML — no framework, no bundler, no server-side code.

## Build, then run

The pages load from `dist/`, which the ads package build generates:

```bash
pnpm -F @videojs/ads build:cdn
npx serve examples/ads
```

`dist/` is gitignored, so a fresh clone has to run that build once. In exchange the example never carries a stale copy of the player, and nothing here reaches outside this folder — copy `examples/ads/` anywhere and it still works.

## The three forms

| Page | Player | Ads | Script tag |
| --- | --- | --- | --- |
| `cdn.html` | jsDelivr | `dist/videojs-ads.js` | `type="module"` × 2 |
| `esm.html` | `dist/video-ads.js` | same file | `type="module"` × 1 |
| `iife.html` | `dist/video-ads.iife.js` | same file | plain `<script>` × 1 |

`cdn.html` needs no build for the player, but `@videojs/ads` is unpublished, so the ads half is always local.

`esm.html` is one file to host — though `video-ads.js` loads locale chunks on demand, which is why `dist/` holds more than the three bundles.

`iife.html` is the option for pages that cannot set `type="module"` at all: a CMS template that injects bare script tags, or a host stuck on older browsers. The bundle hangs its exports on a `VideojsAds` global. It is the largest of the three because an IIFE cannot code-split, so every locale is inlined.

## Ad types

`ads.json` holds one ad of each type the overlay supports:

| Id | Type | Media |
| --- | --- | --- |
| `video-preroll` | `video` | `media/sample-ad.mp4` |
| `image-preroll` | `image` | `media/sample-ad.webp` |

The first entry runs by default. Add `?ad=image-preroll` to any page to pick the other one.

Point `ADS_URL` in `preroll.js` at your own endpoint when you adapt this — the JSON shape is the contract, not the file.

## How it fits together

`dist/video-ads.js` and `dist/video-ads.iife.js` each carry the whole player plus the ads code. `dist/videojs-ads.js` is the ads half alone, for pages that already load a player. All three expose the same three helpers:

| Export | Role |
| --- | --- |
| `fetchAds(url)` | Reads an ad list and drops anything malformed. Returns `[]` on failure, so a broken ad server never blocks playback. |
| `AdsOverlay` | Draws the ad above the player: media, countdown timer, skip button. |
| `trackAdEvent(url, event)` | Fires an impression, complete, skip, or click beacon. No-ops without a `trackingUrl`. |

`preroll.js` holds the lifecycle and is shared by all three pages. It is a classic script rather than a module so `iife.html` can stay free of `type="module"`; each page only differs in how it obtains the three helpers.

The overlay is absolutely positioned, so it needs a container that establishes a positioning context. That is the one non-obvious piece of the markup, and the only reason the pages wrap the player in `<div class="player">`.

## Overlay text

`AdsOverlay` renders four pieces of text, all in English by default. Pass `labels` to change any of them; anything you leave out keeps its default.

```js
new AdsOverlay(container, {
  labels: {
    skip: '광고 건너뛰기',
    skipCountdown: (seconds) => `${seconds}초 후 건너뛰기`,
    timer: (elapsed, duration) => `광고 ${elapsed} / ${duration}`,
    mediaAlt: '광고',
  },
});
```

| Label | Default | Shown |
| --- | --- | --- |
| `skip` | `Skip ad` | On the button once skipping is allowed |
| `skipCountdown(seconds)` | `Skip in 3s` | On the button before `skipAfter` elapses |
| `timer(elapsed, duration)` | `AD 0:05 / 0:10` | Bottom-left readout, times pre-formatted as `m:ss` |
| `mediaAlt` | `Advertisement` | `alt` on an image ad |

The countdown and timer are functions rather than templates because the number does not sit in the same position in every language.

These labels do not go through the player's translation registry — an overlay is constructed directly, not resolved from the player's locale, so you pass the strings you want.

## Known limits

The ad timer runs on `requestAnimationFrame`, so it stalls while the tab is in the background and then resumes out of step with the ad media. `AdsOverlay` does not expose its media element, so a consumer cannot drive the timer from actual playback instead.

## Related

- `apps/sandbox/templates/html-video-ads/` — the same flow with a panel that highlights each phase as it runs. Better for understanding the lifecycle; this example is the smaller starting point.
- [Configure and control the player](../docs/) — what you can set on the player and what you can call on it.
- `packages/ads/README.md` — the package itself.

## Notes

This folder is not a pnpm workspace member and is excluded from Biome by the root `biome.json` ignore list, so it is not linted with the rest of the repository.
