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

  it('requests ads when the source arrives after the element upgraded', async () => {
    // A page that decides on ads after load sets the source late. That only
    // works while the reactive accessors are reachable: declaring the
    // properties as plain class fields defines own properties over them, and
    // the value would land without anything scheduling an update.
    const fetchSpy = vi.fn((_input: RequestInfo | URL) => Promise.resolve(new Response('{"ads":[]}')));
    vi.stubGlobal('fetch', fetchSpy);

    const el = mount();
    expect(Object.hasOwn(el, 'src')).toBe(false);

    el.src = '/ads.json';
    await el.updateComplete;

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('/ads.json');
  });

  describe('timing', () => {
    it('defaults the tick interval and the wall-clock allowance', () => {
      const el = mount({ src: '/ads.json' });

      expect(el.tickInterval).toBeUndefined();
      expect(el.maxWait).toBeUndefined();
      expect(el.resolveTiming()).toEqual({ tickIntervalMs: 250, maxWaitSeconds: 5 });
    });

    it('reads both from attributes', () => {
      const el = mount({ src: '/ads.json', 'tick-interval': '100', 'max-wait': '2' });

      expect(el.resolveTiming()).toEqual({ tickIntervalMs: 100, maxWaitSeconds: 2 });
    });

    it('ignores values that cannot drive a timer', () => {
      // A zero or negative interval would spin; a missing number would produce NaN
      // and stop the countdown advancing at all.
      for (const bad of ['0', '-1', 'soon']) {
        expect(mount({ src: '/ads.json', 'tick-interval': bad }).resolveTiming().tickIntervalMs).toBe(250);
      }
    });

    it('allows a zero wall-clock allowance', () => {
      // Zero is meaningful here: give up the moment the declared duration passes.
      expect(mount({ src: '/ads.json', 'max-wait': '0' }).resolveTiming().maxWaitSeconds).toBe(0);
    });
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
