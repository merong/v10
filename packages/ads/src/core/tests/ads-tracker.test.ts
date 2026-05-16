import { describe, expect, it, vi } from 'vitest';

import { trackAdEvent } from '../ads-tracker';

describe('trackAdEvent', () => {
  it('sends POST request with event data', () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);

    trackAdEvent('https://example.com/track', 'impression', { adId: 'ad-1' });

    expect(fetchSpy).toHaveBeenCalledWith('https://example.com/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'impression', adId: 'ad-1' }),
      keepalive: true,
    });

    vi.unstubAllGlobals();
  });

  it('does nothing when url is undefined', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    trackAdEvent(undefined, 'impression');
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});
