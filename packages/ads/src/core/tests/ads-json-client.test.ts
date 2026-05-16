import { describe, expect, it, vi } from 'vitest';

import { fetchAds } from '../ads-json-client';

describe('fetchAds', () => {
  it('parses valid ads response', async () => {
    const mockResponse = {
      ads: [{ id: 'ad-1', type: 'video', src: '/ad.mp4', mime: 'video/mp4', duration: 15, skipAfter: 5 }],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(mockResponse) }));

    const result = await fetchAds('/api/ads');
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('ad-1');

    vi.unstubAllGlobals();
  });

  it('returns empty array on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

    const result = await fetchAds('/api/ads');
    expect(result).toHaveLength(0);

    vi.unstubAllGlobals();
  });

  it('returns empty array when ads field is missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }));

    const result = await fetchAds('/api/ads');
    expect(result).toHaveLength(0);

    vi.unstubAllGlobals();
  });

  it('returns empty array on HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));

    const result = await fetchAds('/api/ads');
    expect(result).toHaveLength(0);

    vi.unstubAllGlobals();
  });

  it('filters out invalid ad entries', async () => {
    const mockResponse = {
      ads: [
        { id: 'ad-1', type: 'video', src: '/ad.mp4', mime: 'video/mp4', duration: 15, skipAfter: 5 },
        { id: 'ad-2', type: 'invalid' },
        { broken: true },
      ],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(mockResponse) }));

    const result = await fetchAds('/api/ads');
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('ad-1');

    vi.unstubAllGlobals();
  });
});
