const e=`vjs-ads-overlay-style`;function t(){if(document.getElementById(e))return;let t=document.createElement(`style`);t.id=e,t.textContent=`
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
`,document.head.appendChild(t)}function n(e){return`${Math.floor(e/60)}:${Math.floor(e%60).toString().padStart(2,`0`)}`}var r=class{#e;#t;#n;#r;#i=null;#a=null;#o=!1;constructor(e){t(),this.#e=document.createElement(`div`),this.#e.className=`vjs-ads-overlay`,this.#e.dataset.adPhase=`hidden`,this.#r=document.createElement(`div`),this.#r.style.cssText=`width:100%;height:100%;display:flex;align-items:center;justify-content:center;`,this.#t=document.createElement(`div`),this.#t.className=`vjs-ads-timer`,this.#t.textContent=`AD 0:00`,this.#n=document.createElement(`button`),this.#n.className=`vjs-ads-skip`,this.#n.type=`button`,this.#n.dataset.skipAvailable=`false`,this.#n.textContent=`광고 건너뛰기`,this.#n.addEventListener(`click`,()=>{this.#n.dataset.skipAvailable===`true`&&this.#a&&this.#a()}),this.#e.appendChild(this.#r),this.#e.appendChild(this.#t),this.#e.appendChild(this.#n),e.appendChild(this.#e)}showAd(e,t){if(this.#s(),e.type===`video`){let n=document.createElement(`video`);n.className=`vjs-ads-media`,n.src=e.src,n.autoplay=!0,n.playsInline=!0,n.muted=!1,t&&n.addEventListener(`click`,t),this.#r.appendChild(n),this.#i=n}else{let n=document.createElement(`img`);n.className=`vjs-ads-media`,n.src=e.src,n.alt=`Advertisement`,t&&n.addEventListener(`click`,t),this.#r.appendChild(n),this.#i=n}this.#e.dataset.adPhase=`playing`}updateTimer(e,t){this.#t.textContent=`AD ${n(e)} / ${n(t)}`}updateSkip(e,t){this.#n.dataset.skipAvailable=String(e),this.#n.textContent=e?`광고 건너뛰기 ▶`:`${t}초 후 건너뛰기`}onSkip(e){this.#a=e}hide(){this.#s(),this.#e.dataset.adPhase=`hidden`}destroy(){this.#o||(this.#o=!0,this.#s(),this.#e.remove())}#s(){this.#i&&=(this.#i instanceof HTMLVideoElement&&(this.#i.pause(),this.#i.removeAttribute(`src`),this.#i.load()),this.#i.remove(),null)}};function i(e){if(typeof e!=`object`||!e)return!1;let t=e;return typeof t.id==`string`&&(t.type===`video`||t.type===`image`)&&typeof t.src==`string`&&typeof t.mime==`string`&&typeof t.duration==`number`&&typeof t.skipAfter==`number`}function a(e){if(typeof e!=`object`||!e)return!1;let t=e;return Array.isArray(t.ads)}async function o(e,t){try{let n=await fetch(e,t?{signal:t}:void 0);if(!n.ok)return[];let r=await n.json();return a(r)?r.ads.filter(i):[]}catch{return[]}}function s(e,t,n){e&&fetch(e,{method:`POST`,headers:{"Content-Type":`application/json`},body:JSON.stringify({event:t,...n}),keepalive:!0}).catch(()=>{})}export{r as AdsOverlay,o as fetchAds,s as trackAdEvent};
//# sourceMappingURL=videojs-ads.js.map