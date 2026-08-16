import { ContextConsumer } from '@videojs/element/context';
import {
  MediaElement,
  mediaContext,
  type PropertyDeclarationMap,
  type PropertyValues,
  playerContext,
} from '@videojs/html';
import { fetchAds } from '../core/ads-json-client';
import type { Ad } from '../core/ads-state';
import { trackAdEvent } from '../core/ads-tracker';
import { AdsOverlay, type AdsOverlayLabels } from './ads-overlay';

/** How often the countdown refreshes, in milliseconds. */
const DEFAULT_TICK_INTERVAL_MS = 250;

/**
 * Extra wall-clock seconds allowed past an ad's declared duration before it is
 * abandoned. It only matters when the ad's own media stops reporting progress —
 * a stalled video would otherwise hold the content forever.
 */
const DEFAULT_MAX_WAIT_SECONDS = 5;

interface AdTiming {
  tickIntervalMs: number;
  maxWaitSeconds: number;
}

function positiveNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function nonNegativeNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * All this element needs from the player store. Narrow on purpose: asking for
 * only two methods is what lets it sit inside any v10 player rather than one
 * built with an ads feature.
 */
interface PlaybackControls {
  play(): void;
  pause(): void;
}

function asPlaybackControls(store: unknown): PlaybackControls | null {
  const candidate = store as Partial<PlaybackControls> | null | undefined;
  return typeof candidate?.play === 'function' && typeof candidate.pause === 'function'
    ? (candidate as PlaybackControls)
    : null;
}

function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

/**
 * Runs a preroll for the player it sits inside.
 *
 * ```html
 * <video-player>
 *   <video-skin>
 *     <video src="/video.mp4" playsinline></video>
 *     <media-ads src="/ads.json"></media-ads>
 *   </video-skin>
 * </video-player>
 * ```
 *
 * The element draws nothing where it sits; the stylesheet gives it `display:
 * contents` and the overlay it mounts positions against the skin. It stays in
 * light DOM deliberately — a linked stylesheet cannot reach inside the skin's
 * shadow root, so mounting into the shadow container would cost the page its
 * single stylesheet.
 *
 * It deliberately adds no state to the player store. Store features are fixed
 * when a player is built, so requiring one would mean shipping a player of our
 * own; consuming context instead lets this drop into any v10 player bundle.
 */
export class MediaAdsElement extends MediaElement {
  static readonly tagName = 'media-ads';

  static override properties = {
    src: { type: String },
    skipLabel: { type: String, attribute: 'skip-label' },
    skipCountdownLabel: { type: String, attribute: 'skip-countdown-label' },
    timerLabel: { type: String, attribute: 'timer-label' },
    mediaAlt: { type: String, attribute: 'media-alt' },
    tickInterval: { type: Number, attribute: 'tick-interval' },
    maxWait: { type: Number, attribute: 'max-wait' },
  } satisfies PropertyDeclarationMap<
    'src' | 'skipLabel' | 'skipCountdownLabel' | 'timerLabel' | 'mediaAlt' | 'tickInterval' | 'maxWait'
  >;

  src: string | undefined;
  skipLabel: string | undefined;
  skipCountdownLabel: string | undefined;
  timerLabel: string | undefined;
  mediaAlt: string | undefined;
  tickInterval: number | undefined;
  maxWait: number | undefined;

  readonly #player = new ContextConsumer(this, { context: playerContext, subscribe: true });
  readonly #media = new ContextConsumer(this, {
    context: mediaContext,
    subscribe: true,
    callback: (value) => this.#arm(value?.media),
  });

  #overlay: AdsOverlay | null = null;
  #abort: AbortController | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #played = false;
  #armed: HTMLMediaElement | null = null;
  /** In flight from connect; awaited on play so a fast click cannot outrun it. */
  #pending: Promise<Ad[]> | null = null;

  /**
   * Attribute labels as `AdsOverlay` wants them. Absent attributes stay absent
   * so the overlay keeps its own default rather than rendering an empty string.
   *
   * The countdown and timer arrive as templates because an HTML attribute
   * cannot carry a function; `{seconds}`, `{elapsed}`, and `{duration}` mark
   * where the numbers go.
   */
  resolveLabels(): Partial<AdsOverlayLabels> {
    const labels: Partial<AdsOverlayLabels> = {};

    if (this.skipLabel) labels.skip = this.skipLabel;
    if (this.mediaAlt) labels.mediaAlt = this.mediaAlt;

    const countdown = this.skipCountdownLabel;
    if (countdown) labels.skipCountdown = (seconds) => fillTemplate(countdown, { seconds: String(seconds) });

    const timer = this.timerLabel;
    if (timer) labels.timer = (elapsed, duration) => fillTemplate(timer, { elapsed, duration });

    return labels;
  }

  /**
   * Timer settings, with anything unusable falling back to the default. A zero
   * or negative interval would spin, and a non-numeric one would stop the
   * countdown advancing at all — neither is worth honouring.
   *
   * `tickInterval` is milliseconds, matching the timer it drives. `maxWait` is
   * seconds, matching the ad durations it is compared against.
   */
  resolveTiming(): AdTiming {
    return {
      tickIntervalMs: positiveNumber(this.tickInterval, DEFAULT_TICK_INTERVAL_MS),
      maxWaitSeconds: nonNegativeNumber(this.maxWait, DEFAULT_MAX_WAIT_SECONDS),
    };
  }

  override connectedCallback(): void {
    super.connectedCallback();
    if (this.destroyed) return;

    this.#abort = new AbortController();
    this.#request();
  }

  /**
   * Reactive properties are not guaranteed to carry their attribute values by
   * the time `connectedCallback` runs, so the request starts from here too.
   */
  protected override updated(changed: PropertyValues): void {
    super.updated(changed);
    if (changed.has('src')) this.#request();
  }

  /**
   * Starts fetching and waits for play. These are separate concerns on purpose:
   * the viewer may press play before the ad server answers, and the first play
   * is the only one that matters.
   */
  #request(): void {
    if (!this.src || this.#pending || !this.#abort) return;

    this.#pending = fetchAds(this.src, this.#abort.signal);
    this.#arm(this.#media.value?.media);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#teardown();
  }

  override destroyCallback(): void {
    this.#teardown();
    super.destroyCallback();
  }

  #teardown(): void {
    this.#abort?.abort();
    this.#abort = null;
    this.#stopTimer();
    this.#overlay?.destroy();
    this.#overlay = null;
    this.#played = false;
    this.#armed = null;
    this.#pending = null;
  }

  /**
   * Waits for the first play on the content element.
   *
   * The media arrives through context, and it registers after this element
   * connects — so this runs again whenever the context reports a new one
   * rather than reading the value once at connect.
   */
  #arm(media: unknown): void {
    if (!(media instanceof HTMLMediaElement)) return;
    if (this.#armed === media || this.#played || !this.#pending) return;
    if (!this.#abort) return;

    this.#armed = media;
    media.addEventListener('play', () => void this.#start(), { once: true, signal: this.#abort.signal });
  }

  async #start(): Promise<void> {
    if (this.#played) return;
    this.#played = true;

    // Hold the content while the ad list settles. fetchAds resolves to an empty
    // list on any failure, so a broken ad server costs a pause, not playback.
    asPlaybackControls(this.#player.value)?.pause();

    const ad = (await this.#pending)?.[0];
    if (!ad || this.#abort?.signal.aborted) {
      asPlaybackControls(this.#player.value)?.play();
      return;
    }

    // Mounted on this element, which the stylesheet renders as `display:
    // contents` — the overlay positions against the skin, and it stays in light
    // DOM where the page's linked stylesheet can reach it.
    this.#overlay = new AdsOverlay(this, { labels: this.resolveLabels() });
    this.#overlay.showAd(ad, () => {
      trackAdEvent(ad.trackingUrl, 'click');
      if (ad.clickUrl) window.open(ad.clickUrl, '_blank', 'noopener');
    });
    trackAdEvent(ad.trackingUrl, 'impression');
    this.#overlay.onSkip(() => this.#finish(ad, 'skip'));

    this.#runTimer(ad);
  }

  /**
   * Runs the countdown and guarantees the ad ends.
   *
   * A video ad reports its own progress, which is the honest thing to show — it
   * tracks what the viewer actually saw. But it cannot be the only clock: media
   * that fails to load, stalls, or is refused playback never fires `timeupdate`
   * at all, and an ad driven solely by those events holds the content forever.
   *
   * So the wall clock always runs underneath. It supplies the elapsed time when
   * the media reports none, and it ends the ad regardless once the declared
   * duration plus `maxWait` has passed.
   */
  #runTimer(ad: Ad): void {
    const media = this.#overlay?.adMedia;
    const video = media instanceof HTMLVideoElement ? media : null;
    const { tickIntervalMs, maxWaitSeconds } = this.resolveTiming();
    const startedAt = Date.now();

    const render = (elapsed: number): void => {
      this.#overlay?.updateTimer(elapsed, ad.duration);
      const canSkip = ad.skipAfter > 0 && elapsed >= ad.skipAfter;
      this.#overlay?.updateSkip(canSkip, Math.max(0, Math.ceil(ad.skipAfter - elapsed)));
    };

    const tick = (): void => {
      const wall = (Date.now() - startedAt) / 1000;
      // Media progress wins while there is any, so the countdown reflects the
      // ad rather than the clock. At zero it has not started, and wall time is
      // the only honest answer.
      const elapsed = video && video.currentTime > 0 ? video.currentTime : wall;

      render(elapsed);

      if (elapsed >= ad.duration || wall >= ad.duration + maxWaitSeconds) {
        this.#finish(ad, 'complete');
      }
    };

    render(0);

    if (video) {
      video.addEventListener('timeupdate', tick);
      video.addEventListener('ended', () => this.#finish(ad, 'complete'));
      // Nothing is coming; do not make the viewer wait out the duration.
      video.addEventListener('error', () => this.#finish(ad, 'error'));
    }

    this.#timer = setInterval(tick, tickIntervalMs);
  }

  #stopTimer(): void {
    if (this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  #finish(ad: Ad, reason: 'skip' | 'complete' | 'error'): void {
    if (!this.#overlay) return;

    this.#stopTimer();
    trackAdEvent(ad.trackingUrl, reason);
    this.#overlay.destroy();
    this.#overlay = null;
    asPlaybackControls(this.#player.value)?.play();
  }
}
