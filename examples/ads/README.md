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

That page's script tag carries `defer`, and it has to. A classic script runs while the parser is still working, so `<video-player>` upgrades before its `<video>` child exists; the player looks for media once, finds none, and never attaches — the controls render but stay inert. Module scripts are deferred already. Putting the script at the end of `<body>` works too.

## Ad types

`ads.json` holds one ad of each type the overlay supports:

| Id | Type | Media |
| --- | --- | --- |
| `video-preroll` | `video` | `media/sample-ad.mp4` |
| `image-preroll` | `image` | `media/sample-ad.webp` |

The first entry runs. Point `<media-ads src>` at your own endpoint when you adapt this — the JSON shape is the contract, not the file.

## How it fits together

There is no wiring code on any of these pages. `<media-ads>` finds the player through context, fetches the list, waits for the first play, runs the ad, and hands playback back.

```html
<video-player>
  <video-skin>
    <video src="/video.mp4" playsinline></video>
    <media-ads src="/ads.json"></media-ads>
  </video-skin>
</video-player>
```

`dist/video-ads.js` and `dist/video-ads.iife.js` each carry the whole player plus the ads code. `dist/videojs-ads.js` is the ads half alone, for a page that already loads a player. All three also export `fetchAds`, `AdsOverlay`, and `trackAdEvent` for driving an ad by hand instead.

The element adds nothing to the player store. Store features are fixed when a player is built, so an ads feature would mean shipping a player of our own; consuming context instead means `<media-ads>` drops into any v10 player bundle.

## Overlay text

Four pieces of text, all in English by default. Set them as attributes; anything you leave out keeps its default.

```html
<media-ads
  src="/ads.json"
  skip-label="광고 건너뛰기"
  skip-countdown-label="{seconds}초 후 건너뛰기"
  timer-label="광고 {elapsed} / {duration}"
  media-alt="광고"
></media-ads>
```

An attribute cannot carry a function, so the countdown and timer take templates — `{seconds}`, `{elapsed}`, and `{duration}` mark where the numbers go. Driving `AdsOverlay` by hand takes the same labels as functions.

| Label | Default | Shown |
| --- | --- | --- |
| `skip` | `Skip ad` | On the button once skipping is allowed |
| `skipCountdown(seconds)` | `Skip in 3s` | On the button before `skipAfter` elapses |
| `timer(elapsed, duration)` | `AD 0:05 / 0:10` | Bottom-left readout, times pre-formatted as `m:ss` |
| `mediaAlt` | `Advertisement` | `alt` on an image ad |

The countdown and timer are functions rather than templates because the number does not sit in the same position in every language.

These labels do not go through the player's translation registry — an overlay is constructed directly, not resolved from the player's locale, so you pass the strings you want.

## Timing

The countdown follows the ad's own playback when it reports any, and a wall clock underneath guarantees the ad ends even when it does not — media that fails to load, stalls, or is refused playback would otherwise hold the content forever.

| Attribute | Default | Meaning |
| --- | --- | --- |
| `tick-interval` | `250` | How often the countdown refreshes, in milliseconds. |
| `max-wait` | `5` | Extra wall-clock seconds allowed past `duration` before the ad is abandoned, in seconds. |

```html
<media-ads src="/ads.json" tick-interval="100" max-wait="2"></media-ads>
```

An ad whose media errors is dropped immediately rather than waiting out either clock, and reports a `error` tracking event rather than `complete`.

## Known limits

In a background tab the browser throttles the wall-clock timer, so an ad with no media progress of its own finishes late. A playing video ad is unaffected — its countdown follows `timeupdate`.

## Related

- `apps/sandbox/templates/html-video-ads/` — the same flow with a panel that highlights each phase as it runs. Better for understanding the lifecycle; this example is the smaller starting point.
- [Configure and control the player](../docs/) — what you can set on the player and what you can call on it.
- `packages/ads/README.md` — the package itself.

## Notes

This folder is not a pnpm workspace member and is excluded from Biome by the root `biome.json` ignore list, so it is not linted with the rest of the repository.
