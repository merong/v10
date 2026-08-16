import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MediaAdsElement } from '../../define/media-ads';

function mount(attrs: Record<string, string> = {}): MediaAdsElement {
  const el = document.createElement('media-ads') as MediaAdsElement;
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  document.body.appendChild(el);
  return el;
}

describe('MediaAdsElement', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('registers as media-ads', () => {
    expect(customElements.get('media-ads')).toBe(MediaAdsElement);
  });

  it('reads the ad source from src', () => {
    expect(mount({ src: '/ads.json' }).src).toBe('/ads.json');
  });

  it('renders nothing until an ad runs', () => {
    // The element is a marker. The stylesheet gives it `display: contents`, so
    // the overlay it later holds positions against the skin rather than against
    // a box of its own.
    expect(mount({ src: '/ads.json' }).children).toHaveLength(0);
  });

  it('does nothing without a src', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    mount();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  describe('labels', () => {
    it('passes attribute labels through to the overlay', () => {
      const el = mount({
        src: '/ads.json',
        'skip-label': '광고 건너뛰기',
        'skip-countdown-label': '{seconds}초 후 건너뛰기',
        'timer-label': '광고 {elapsed} / {duration}',
        'media-alt': '광고',
      });

      const labels = el.resolveLabels();

      expect(labels.skip).toBe('광고 건너뛰기');
      expect(labels.skipCountdown?.(5)).toBe('5초 후 건너뛰기');
      expect(labels.timer?.('0:05', '0:10')).toBe('광고 0:05 / 0:10');
      expect(labels.mediaAlt).toBe('광고');
    });

    it('leaves labels undefined when the attribute is absent', () => {
      // Undefined rather than empty, so AdsOverlay falls back to its default
      // instead of rendering a blank button.
      const labels = mount({ src: '/ads.json' }).resolveLabels();

      expect(labels.skip).toBeUndefined();
      expect(labels.skipCountdown).toBeUndefined();
      expect(labels.timer).toBeUndefined();
      expect(labels.mediaAlt).toBeUndefined();
    });

    it('substitutes every occurrence of a placeholder', () => {
      const el = mount({ src: '/ads.json', 'skip-countdown-label': '{seconds} · {seconds}s' });

      expect(el.resolveLabels().skipCountdown?.(3)).toBe('3 · 3s');
    });
  });
});
