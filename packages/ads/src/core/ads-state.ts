export type AdMediaType = 'video' | 'image';

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
