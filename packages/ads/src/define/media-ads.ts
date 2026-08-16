import { MediaAdsElement } from '../dom/media-ads-element';

// Guarded because a page can load more than one bundle carrying this element,
// and defining a tag twice throws.
if (!customElements.get(MediaAdsElement.tagName)) {
  customElements.define(MediaAdsElement.tagName, MediaAdsElement);
}

declare global {
  interface HTMLElementTagNameMap {
    [MediaAdsElement.tagName]: MediaAdsElement;
  }
}

export { MediaAdsElement };
