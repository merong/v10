import { describe, expect, it } from 'vitest';

import { AdsOverlay } from '../ads-overlay';

describe('AdsOverlay', () => {
  it('creates overlay DOM structure', () => {
    const container = document.createElement('div');
    new AdsOverlay(container);

    expect(container.querySelector('.vjs-ads-overlay')).not.toBeNull();
    expect(container.querySelector('.vjs-ads-timer')).not.toBeNull();
    expect(container.querySelector('.vjs-ads-skip')).not.toBeNull();
  });

  it('shows video ad media', () => {
    const container = document.createElement('div');
    const overlay = new AdsOverlay(container);

    overlay.showAd({
      id: 'ad-1',
      type: 'video',
      src: '/ad.mp4',
      mime: 'video/mp4',
      duration: 15,
      skipAfter: 5,
    });

    const video = container.querySelector('video.vjs-ads-media');
    expect(video).not.toBeNull();
  });

  it('shows image ad media', () => {
    const container = document.createElement('div');
    const overlay = new AdsOverlay(container);

    overlay.showAd({
      id: 'ad-2',
      type: 'image',
      src: '/ad.webp',
      mime: 'image/webp',
      duration: 5,
      skipAfter: 3,
    });

    const img = container.querySelector('img.vjs-ads-media');
    expect(img).not.toBeNull();
  });

  it('updates timer display', () => {
    const container = document.createElement('div');
    const overlay = new AdsOverlay(container);

    overlay.updateTimer(5.2, 15);
    const timer = container.querySelector('.vjs-ads-timer');
    expect(timer?.textContent).toContain('0:05');
    expect(timer?.textContent).toContain('0:15');
  });

  it('updates skip button state', () => {
    const container = document.createElement('div');
    const overlay = new AdsOverlay(container);

    overlay.updateSkip(false, 3);
    const skip = container.querySelector('.vjs-ads-skip') as HTMLElement;
    expect(skip.dataset.skipAvailable).toBe('false');
    expect(skip.textContent).toContain('3');

    overlay.updateSkip(true, 0);
    expect(skip.dataset.skipAvailable).toBe('true');
  });

  it('hides overlay', () => {
    const container = document.createElement('div');
    const overlay = new AdsOverlay(container);

    overlay.showAd({
      id: 'ad-1',
      type: 'video',
      src: '/ad.mp4',
      mime: 'video/mp4',
      duration: 15,
      skipAfter: 5,
    });
    overlay.hide();

    const el = container.querySelector('.vjs-ads-overlay') as HTMLElement;
    expect(el.dataset.adPhase).toBe('hidden');
  });

  it('clears previous media when showing new ad', () => {
    const container = document.createElement('div');
    const overlay = new AdsOverlay(container);

    overlay.showAd({ id: 'ad-1', type: 'video', src: '/a.mp4', mime: 'video/mp4', duration: 10, skipAfter: 5 });
    overlay.showAd({ id: 'ad-2', type: 'image', src: '/b.webp', mime: 'image/webp', duration: 5, skipAfter: 3 });

    expect(container.querySelectorAll('.vjs-ads-media')).toHaveLength(1);
    expect(container.querySelector('img.vjs-ads-media')).not.toBeNull();
  });

  it('destroy removes overlay from DOM', () => {
    const container = document.createElement('div');
    const overlay = new AdsOverlay(container);
    overlay.destroy();

    expect(container.querySelector('.vjs-ads-overlay')).toBeNull();
  });

  it('destroy is idempotent', () => {
    const container = document.createElement('div');
    const overlay = new AdsOverlay(container);
    overlay.destroy();
    overlay.destroy(); // should not throw
    expect(container.querySelector('.vjs-ads-overlay')).toBeNull();
  });

  describe('labels', () => {
    it('defaults to English', () => {
      const container = document.createElement('div');
      const overlay = new AdsOverlay(container);
      const skip = container.querySelector('.vjs-ads-skip') as HTMLElement;

      expect(skip.textContent).toBe('Skip ad');

      overlay.updateSkip(false, 3);
      expect(skip.textContent).toBe('Skip in 3s');

      overlay.updateSkip(true, 0);
      expect(skip.textContent).toBe('Skip ad');
    });

    it('overrides the skip labels', () => {
      const container = document.createElement('div');
      const overlay = new AdsOverlay(container, {
        labels: {
          skip: '광고 건너뛰기',
          skipCountdown: (seconds) => `${seconds}초 후 건너뛰기`,
        },
      });
      const skip = container.querySelector('.vjs-ads-skip') as HTMLElement;

      expect(skip.textContent).toBe('광고 건너뛰기');

      overlay.updateSkip(false, 5);
      expect(skip.textContent).toBe('5초 후 건너뛰기');
    });

    it('overrides the timer readout', () => {
      const container = document.createElement('div');
      const overlay = new AdsOverlay(container, {
        labels: { timer: (elapsed, duration) => `광고 ${elapsed} / ${duration}` },
      });

      overlay.updateTimer(5.2, 15);
      expect(container.querySelector('.vjs-ads-timer')?.textContent).toBe('광고 0:05 / 0:15');
    });

    it('overrides the image ad alt text', () => {
      const container = document.createElement('div');
      const overlay = new AdsOverlay(container, { labels: { mediaAlt: '광고' } });

      overlay.showAd({ id: 'ad-1', type: 'image', src: '/a.webp', mime: 'image/webp', duration: 5, skipAfter: 3 });

      expect(container.querySelector('img.vjs-ads-media')?.getAttribute('alt')).toBe('광고');
    });

    it('keeps the defaults that were not overridden', () => {
      const container = document.createElement('div');
      const overlay = new AdsOverlay(container, { labels: { skip: 'Skip' } });
      const skip = container.querySelector('.vjs-ads-skip') as HTMLElement;

      expect(skip.textContent).toBe('Skip');

      // Untouched, so still the English default rather than undefined.
      overlay.updateSkip(false, 2);
      expect(skip.textContent).toBe('Skip in 2s');
    });
  });
});
