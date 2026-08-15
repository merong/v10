# Preroll ad example

A plain HTML page that plays a skippable preroll before its content. No build step, no framework, no bundler.

## Run it

The page loads the player from `packages/ads/cdn/`, so serve the repository root rather than this folder:

```bash
npx serve .
```

Then open <http://localhost:3000/examples/ads/> and press play. A 10-second ad runs first and becomes skippable after 3 seconds.

## What it shows

`packages/ads/cdn/video-ads.js` is one self-contained bundle holding both the Video.js 10 player and the ads overlay. Loading it registers `<video-player>` and `<video-skin>`, and exports the three helpers this example uses:

| Export | Role |
| --- | --- |
| `fetchAds(url)` | Reads an ad list and drops anything malformed. Returns `[]` on failure, so a broken ad server never blocks playback. |
| `AdsOverlay` | Draws the ad above the player: media, countdown timer, skip button. |
| `trackAdEvent(url, event)` | Fires an impression, complete, skip, or click beacon. No-ops without a `trackingUrl`. |

The overlay is absolutely positioned, so it needs a container that establishes a positioning context — that is the only reason `index.html` wraps the player in `<div class="player">`.

Ad data lives in `ads.json`. Swap it for your own endpoint by changing `ADS_URL` in `main.js`; the shape is the contract, not the file.

## Use it in your own project

Copy `index.html`, `main.js`, and `ads.json`, then change the import in `main.js` to wherever you host the bundle:

```js
import { AdsOverlay, fetchAds, trackAdEvent } from '/vendor/video-ads.js';
```

The bundle is ES module output, so the script tag that loads `main.js` needs `type="module"`. See [load the player with a script tag](../../site/src/content/docs/how-to/load-with-a-script-tag.mdx) for the loading options and their trade-offs.

## Related

- `apps/sandbox/templates/html-video-ads/` — the same flow with a step-by-step panel that highlights each phase as it runs. Better for understanding the lifecycle; this example is the smaller starting point.
- `packages/ads/README.md` — the package itself.

## Notes

This folder is not a pnpm workspace member and is excluded from Biome by the root `biome.json` ignore list, so it is not linted with the rest of the repository.
