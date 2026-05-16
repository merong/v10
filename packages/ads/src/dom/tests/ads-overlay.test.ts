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
});
