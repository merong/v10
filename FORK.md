# Fork guide

This repository is a long-lived fork of [videojs/v10](https://github.com/videojs/v10). Read this before `AGENTS.md`: where the two disagree, this file wins, because `AGENTS.md` is upstream's and describes upstream's priorities.

## What the fork is for

Upstream ships a player. The fork adds one thing to it — ads — and packages the result so a plain HTML page can use it without a bundler, a framework, or a build step of its own.

Done looks like this:

```html
<link rel="stylesheet" href="/videojs-ads.css" />
<script src="/videojs-ads.js"></script>

<video-player>
  <video-skin>
    <video src="/video.mp4" playsinline></video>
    <media-ads src="/ads.json"></media-ads>
  </video-skin>
</video-player>
```

One JS file, one CSS file, no init call. IIFE is the primary output; ESM ships the same thing as a single file for anyone who wants it.

Ads are a plugin in the shape the player already uses: a custom element that finds the player through context and wires itself up. Everything else in v10 is a custom element configured by markup, and a plugin that is not one would be the odd thing out.

## The cost principle

**The fork's maintenance cost is not the amount of code it adds. It is the amount of upstream's tree it touches.**

The last sync took 255 upstream commits with 19 breaking changes. It produced six conflicts, and every one was in a file the fork had edited inside upstream's tree — three of them in `apps/sandbox/`. Nothing in `packages/ads/` conflicted, because upstream has no such directory.

So:

- New code goes in `packages/ads/` or `examples/`. Both are fork-owned; upstream will never touch them.
- Editing a shared file is a recurring bill, not a one-time edit. Pay it only when there is no fork-owned alternative, and keep the edit to as few lines as possible.
- When a shared file must change, prefer adding a line over restructuring existing lines. A one-line addition usually merges; a reordering usually does not.

The fork currently touches six shared files, each by a line or two: `.gitignore`, `biome.json`, `commitlint.config.js`, `.github/workflows/ci.yml`, `tsconfig.json`, and `pnpm-lock.yaml`.

## Documentation boundary

Upstream's `site/` documents upstream's player. The fork does not publish that site, so writing there buys nothing and costs a conflict.

Fork documentation lives in `examples/docs/`, is served statically alongside the examples, and covers only what the fork adds or changes.

One document per subject. Before writing a new one, find the existing one — this fork has already grown six overlapping documents once.

## Build artifacts are generated, not committed

`examples/ads/dist/` is produced by the ads build and gitignored. Committed bundles go stale, bloat diffs, and turn every rebuild into noise in `git status`.

The same applies to `packages/ads/cdn/`.

## Examples and docs follow the shipped shape

When the public shape changes, examples and documentation are rewritten against the new shape, not patched toward it. A page that demonstrates a superseded API teaches the wrong thing, and the edits needed to convert it usually exceed the cost of writing it again.

## Excluded, and why

| Excluded | Reason |
| --- | --- |
| A player guide in upstream's `site/` | Documents upstream's product in upstream's tree. The fork gains nothing and pays a conflict. |
| Ad demos in `apps/sandbox/` | Duplicates `examples/ads/` while editing five shared sandbox files and carrying 3.1 MB of fixtures inside upstream's tree. |
| `packages/ads/INSTALL.md` | Overlapped `README.md`; its file-copying instructions assumed the sandbox demo. |
| `.agents/plans/` entries for shipped work | `AGENTS.md` already calls these temporary. A 1,373-line plan for finished work is read as current design and misleads. |
| Committed `cdn/` bundles | See above. |

## Merging upstream

```bash
git fetch upstream && git merge upstream/main
```

Conflicts land only in the shared files listed above, so the set is small and predictable.

Three things make verification fail for reasons that have nothing to do with the merge. Check them before believing a failure:

1. `pnpm clean` leaves `.tsbuildinfo` behind, so `tsgo --build` thinks declarations are current and typechecks new source against stale ones. Delete them: `find . -name '*.tsbuildinfo' -not -path './node_modules/*' -delete`.
2. `apps/sandbox/src/` keeps directories whose templates upstream renamed or deleted, and the sandbox build then fails on a missing import. The directory is generated; delete the orphans.
3. `pnpm test` crashes workers under parallel load. `pnpm turbo test --concurrency=1` passes.

Also: a shell pipeline like `pnpm typecheck | tail -5 && echo OK` reports the exit code of `tail`, not of the typecheck. Capture the real status.
