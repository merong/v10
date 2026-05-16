import type { Ad, AdsResponse } from './ads-state';

function isAd(value: unknown): value is Ad {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    (obj.type === 'video' || obj.type === 'image') &&
    typeof obj.src === 'string' &&
    typeof obj.mime === 'string' &&
    typeof obj.duration === 'number' &&
    typeof obj.skipAfter === 'number'
  );
}

function isAdsResponse(value: unknown): value is AdsResponse {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return Array.isArray(obj.ads);
}

export async function fetchAds(url: string, signal?: AbortSignal): Promise<Ad[]> {
  try {
    const response = await fetch(url, signal ? { signal } : undefined);
    if (!response.ok) return [];

    const data: unknown = await response.json();
    if (!isAdsResponse(data)) return [];

    return data.ads.filter(isAd);
  } catch {
    return [];
  }
}
