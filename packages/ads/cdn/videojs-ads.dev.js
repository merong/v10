//#region src/dom/ads-overlay.ts
const ADS_STYLE_ID = "vjs-ads-overlay-style";
const ADS_CSS = `
.vjs-ads-overlay {
  position: absolute;
  inset: 0;
  z-index: 100;
  display: none;
  background: #000;
}
.vjs-ads-overlay[data-ad-phase='playing'] {
  display: flex;
  align-items: center;
  justify-content: center;
}
.vjs-ads-overlay[data-ad-phase='hidden'] {
  display: none;
}
.vjs-ads-media {
  width: 100%;
  height: 100%;
  object-fit: contain;
  cursor: pointer;
}
.vjs-ads-timer {
  position: absolute;
  bottom: 12px;
  left: 12px;
  padding: 4px 10px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.7);
  color: #fff;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
  user-select: none;
}
.vjs-ads-skip {
  position: absolute;
  bottom: 12px;
  right: 12px;
  padding: 6px 14px;
  border: 1px solid rgba(255, 255, 255, 0.5);
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.7);
  color: #fff;
  font-size: 13px;
  cursor: default;
  user-select: none;
  transition: background 0.15s, border-color 0.15s;
}
.vjs-ads-skip[data-skip-available='true'] {
  cursor: pointer;
  border-color: #fff;
}
.vjs-ads-skip[data-skip-available='true']:hover {
  background: rgba(255, 255, 255, 0.2);
}
`;
function injectStyles() {
	if (document.getElementById(ADS_STYLE_ID)) return;
	const style = document.createElement("style");
	style.id = ADS_STYLE_ID;
	style.textContent = ADS_CSS;
	document.head.appendChild(style);
}
function formatTime(seconds) {
	return `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
}
var AdsOverlay = class {
	#root;
	#timer;
	#skip;
	#mediaContainer;
	#adMedia = null;
	#onSkip = null;
	#destroyed = false;
	constructor(container) {
		injectStyles();
		this.#root = document.createElement("div");
		this.#root.className = "vjs-ads-overlay";
		this.#root.dataset.adPhase = "hidden";
		this.#mediaContainer = document.createElement("div");
		this.#mediaContainer.style.cssText = "width:100%;height:100%;display:flex;align-items:center;justify-content:center;";
		this.#timer = document.createElement("div");
		this.#timer.className = "vjs-ads-timer";
		this.#timer.textContent = "AD 0:00";
		this.#skip = document.createElement("button");
		this.#skip.className = "vjs-ads-skip";
		this.#skip.type = "button";
		this.#skip.dataset.skipAvailable = "false";
		this.#skip.textContent = "광고 건너뛰기";
		this.#skip.addEventListener("click", () => {
			if (this.#skip.dataset.skipAvailable === "true" && this.#onSkip) this.#onSkip();
		});
		this.#root.appendChild(this.#mediaContainer);
		this.#root.appendChild(this.#timer);
		this.#root.appendChild(this.#skip);
		container.appendChild(this.#root);
	}
	showAd(ad, onClick) {
		this.#clearMedia();
		if (ad.type === "video") {
			const video = document.createElement("video");
			video.className = "vjs-ads-media";
			video.src = ad.src;
			video.autoplay = true;
			video.playsInline = true;
			video.muted = false;
			if (onClick) video.addEventListener("click", onClick);
			this.#mediaContainer.appendChild(video);
			this.#adMedia = video;
		} else {
			const img = document.createElement("img");
			img.className = "vjs-ads-media";
			img.src = ad.src;
			img.alt = "Advertisement";
			if (onClick) img.addEventListener("click", onClick);
			this.#mediaContainer.appendChild(img);
			this.#adMedia = img;
		}
		this.#root.dataset.adPhase = "playing";
	}
	updateTimer(currentTime, duration) {
		this.#timer.textContent = `AD ${formatTime(currentTime)} / ${formatTime(duration)}`;
	}
	updateSkip(available, countdown) {
		this.#skip.dataset.skipAvailable = String(available);
		this.#skip.textContent = available ? "광고 건너뛰기 ▶" : `${countdown}초 후 건너뛰기`;
	}
	onSkip(callback) {
		this.#onSkip = callback;
	}
	hide() {
		this.#clearMedia();
		this.#root.dataset.adPhase = "hidden";
	}
	destroy() {
		if (this.#destroyed) return;
		this.#destroyed = true;
		this.#clearMedia();
		this.#root.remove();
	}
	#clearMedia() {
		if (this.#adMedia) {
			if (this.#adMedia instanceof HTMLVideoElement) {
				this.#adMedia.pause();
				this.#adMedia.removeAttribute("src");
				this.#adMedia.load();
			}
			this.#adMedia.remove();
			this.#adMedia = null;
		}
	}
};

//#endregion
//#region src/core/ads-json-client.ts
function isAd(value) {
	if (typeof value !== "object" || value === null) return false;
	const obj = value;
	return typeof obj.id === "string" && (obj.type === "video" || obj.type === "image") && typeof obj.src === "string" && typeof obj.mime === "string" && typeof obj.duration === "number" && typeof obj.skipAfter === "number";
}
function isAdsResponse(value) {
	if (typeof value !== "object" || value === null) return false;
	const obj = value;
	return Array.isArray(obj.ads);
}
async function fetchAds(url, signal) {
	try {
		const response = await fetch(url, signal ? { signal } : void 0);
		if (!response.ok) return [];
		const data = await response.json();
		if (!isAdsResponse(data)) return [];
		return data.ads.filter(isAd);
	} catch {
		return [];
	}
}

//#endregion
//#region src/core/ads-tracker.ts
function trackAdEvent(url, event, extra) {
	if (!url) return;
	fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			event,
			...extra
		}),
		keepalive: true
	}).catch(() => {});
}

//#endregion
export { AdsOverlay, fetchAds, trackAdEvent };
//# sourceMappingURL=videojs-ads.dev.js.map