export type AdMediaType = 'video' | 'image';

export type AdPhase = 'idle' | 'loading' | 'ready' | 'playing' | 'skipped' | 'done' | 'error';

export interface Ad {
  id: string;
  type: AdMediaType;
  src: string;
  mime: string;
  duration: number;
  skipAfter: number;
  clickUrl?: string;
  trackingUrl?: string;
}

export interface AdsResponse {
  ads: Ad[];
}

export interface MediaAdsState {
  adPhase: AdPhase;
  currentAd: Ad | null;
  adCurrentTime: number;
  adDuration: number;
  skipAvailable: boolean;
  skipCountdown: number;
  loadAds(url: string): Promise<void>;
  skipAd(): void;
}
