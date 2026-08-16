import type { Ad } from '../core/ads-state';

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Text the overlay renders. The countdown and timer are functions because the
 * number does not sit in the same place in every language.
 */
export interface AdsOverlayLabels {
  /** Skip button once skipping is allowed. */
  skip: string;
  /** Skip button before `skipAfter` elapses, given whole seconds remaining. */
  skipCountdown: (seconds: number) => string;
  /** Elapsed and total readout, both already formatted as `m:ss`. */
  timer: (elapsed: string, duration: string) => string;
  /** Alternative text on an image ad. */
  mediaAlt: string;
}

export interface AdsOverlayOptions {
  /** Overrides for the text above. Anything left out keeps its default. */
  labels?: Partial<AdsOverlayLabels>;
}

const DEFAULT_LABELS: AdsOverlayLabels = {
  skip: 'Skip ad',
  skipCountdown: (seconds) => `Skip in ${seconds}s`,
  timer: (elapsed, duration) => `AD ${elapsed} / ${duration}`,
  mediaAlt: 'Advertisement',
};

export class AdsOverlay {
  #root: HTMLElement;
  #timer: HTMLElement;
  #skip: HTMLButtonElement;
  #mediaContainer: HTMLElement;
  #adMedia: HTMLVideoElement | HTMLImageElement | null = null;
  #onSkip: (() => void) | null = null;
  #destroyed = false;
  #labels: AdsOverlayLabels;

  constructor(container: HTMLElement, options: AdsOverlayOptions = {}) {
    this.#labels = { ...DEFAULT_LABELS, ...options.labels };

    this.#root = document.createElement('div');
    this.#root.className = 'vjs-ads-overlay';
    this.#root.dataset.adPhase = 'hidden';

    this.#mediaContainer = document.createElement('div');
    this.#mediaContainer.style.cssText =
      'width:100%;height:100%;display:flex;align-items:center;justify-content:center;';

    this.#timer = document.createElement('div');
    this.#timer.className = 'vjs-ads-timer';
    this.#timer.textContent = this.#labels.timer(formatTime(0), formatTime(0));

    this.#skip = document.createElement('button');
    this.#skip.className = 'vjs-ads-skip';
    this.#skip.type = 'button';
    this.#skip.dataset.skipAvailable = 'false';
    this.#skip.textContent = this.#labels.skip;
    this.#skip.addEventListener('click', () => {
      if (this.#skip.dataset.skipAvailable === 'true' && this.#onSkip) {
        this.#onSkip();
      }
    });

    this.#root.appendChild(this.#mediaContainer);
    this.#root.appendChild(this.#timer);
    this.#root.appendChild(this.#skip);
    container.appendChild(this.#root);
  }

  /**
   * The element currently presenting the ad, or `null` between ads.
   *
   * A video ad reports its own progress, so an owner can drive the countdown
   * from `timeupdate` rather than a wall clock that keeps running while the
   * media does not. An image ad has no clock of its own and needs one supplied.
   */
  get adMedia(): HTMLVideoElement | HTMLImageElement | null {
    return this.#adMedia;
  }

  showAd(ad: Ad, onClick?: () => void): void {
    this.#clearMedia();

    if (ad.type === 'video') {
      const video = document.createElement('video');
      video.className = 'vjs-ads-media';
      video.src = ad.src;
      video.autoplay = true;
      video.playsInline = true;
      video.muted = false;
      if (onClick) video.addEventListener('click', onClick);
      this.#mediaContainer.appendChild(video);
      this.#adMedia = video;
    } else {
      const img = document.createElement('img');
      img.className = 'vjs-ads-media';
      img.src = ad.src;
      img.alt = this.#labels.mediaAlt;
      if (onClick) img.addEventListener('click', onClick);
      this.#mediaContainer.appendChild(img);
      this.#adMedia = img;
    }

    this.#root.dataset.adPhase = 'playing';
  }

  updateTimer(currentTime: number, duration: number): void {
    this.#timer.textContent = this.#labels.timer(formatTime(currentTime), formatTime(duration));
  }

  updateSkip(available: boolean, countdown: number): void {
    this.#skip.dataset.skipAvailable = String(available);
    this.#skip.textContent = available ? this.#labels.skip : this.#labels.skipCountdown(countdown);
  }

  onSkip(callback: () => void): void {
    this.#onSkip = callback;
  }

  hide(): void {
    this.#clearMedia();
    this.#root.dataset.adPhase = 'hidden';
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#clearMedia();
    this.#root.remove();
  }

  #clearMedia(): void {
    if (this.#adMedia) {
      if (this.#adMedia instanceof HTMLVideoElement) {
        this.#adMedia.pause();
        this.#adMedia.removeAttribute('src');
        this.#adMedia.load();
      }
      this.#adMedia.remove();
      this.#adMedia = null;
    }
  }
}
