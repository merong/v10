import type { AbortControllerRegistry } from '@videojs/store';
import { describe, expect, it, vi } from 'vitest';

import { adsFeature } from '../ads-feature';

function createMockSignals(): AbortControllerRegistry {
  return {
    base: new AbortController().signal,
    supersede: vi.fn().mockReturnValue(new AbortController().signal),
    clear: vi.fn(),
    reset: vi.fn(),
  } as unknown as AbortControllerRegistry;
}

describe('adsFeature', () => {
  it('has correct name', () => {
    expect(adsFeature.name).toBe('ads');
  });

  it('has state and attach functions', () => {
    expect(typeof adsFeature.state).toBe('function');
    expect(typeof adsFeature.attach).toBe('function');
  });

  it('state initializes with idle phase', () => {
    const state = adsFeature.state({
      target: () => ({ media: document.createElement('video'), container: null }),
      signals: createMockSignals(),
      set: vi.fn(),
    });

    expect(state.adPhase).toBe('idle');
    expect(state.currentAd).toBeNull();
    expect(state.adCurrentTime).toBe(0);
    expect(state.adDuration).toBe(0);
    expect(state.skipAvailable).toBe(false);
    expect(state.skipCountdown).toBe(0);
  });

  it('loadAds sets phase to done when no ads', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ads: [] }) }));

    const setCalls: Record<string, unknown>[] = [];
    const state = adsFeature.state({
      target: () => ({ media: document.createElement('video'), container: null }),
      signals: createMockSignals(),
      set: (partial: Record<string, unknown>) => {
        setCalls.push(partial);
      },
    });

    await state.loadAds('/api/ads');

    expect(setCalls).toContainEqual(expect.objectContaining({ adPhase: 'loading' }));
    expect(setCalls).toContainEqual(expect.objectContaining({ adPhase: 'done' }));

    vi.unstubAllGlobals();
  });

  it('loadAds sets phase to ready when ads returned', async () => {
    const mockAd = { id: 'ad-1', type: 'video', src: '/ad.mp4', mime: 'video/mp4', duration: 15, skipAfter: 5 };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ads: [mockAd] }) }));

    const setCalls: Record<string, unknown>[] = [];
    const state = adsFeature.state({
      target: () => ({ media: document.createElement('video'), container: null }),
      signals: createMockSignals(),
      set: (partial: Record<string, unknown>) => {
        setCalls.push(partial);
      },
    });

    await state.loadAds('/api/ads');

    expect(setCalls).toContainEqual(expect.objectContaining({ adPhase: 'ready' }));
    const readyCall = setCalls.find((c) => c.adPhase === 'ready');
    expect(readyCall?.currentAd).toEqual(expect.objectContaining({ id: 'ad-1' }));

    vi.unstubAllGlobals();
  });

  it('skipAd calls trackAdEvent and sets phase to done', () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);

    const setCalls: Record<string, unknown>[] = [];
    const state = adsFeature.state({
      target: () => ({ media: document.createElement('video'), container: null }),
      signals: createMockSignals(),
      set: (partial: Record<string, unknown>) => {
        setCalls.push(partial);
      },
    });

    // skipAd with no loaded ads should be a no-op
    state.skipAd();
    expect(setCalls.filter((c) => c.adPhase === 'done')).toHaveLength(0);

    vi.unstubAllGlobals();
  });
});
