function e(e){if(typeof e!=`object`||!e)return!1;let t=e;return typeof t.id==`string`&&(t.type===`video`||t.type===`image`)&&typeof t.src==`string`&&typeof t.mime==`string`&&typeof t.duration==`number`&&typeof t.skipAfter==`number`}function t(e){if(typeof e!=`object`||!e)return!1;let t=e;return Array.isArray(t.ads)}async function n(n,r){try{let i=await fetch(n,r?{signal:r}:void 0);if(!i.ok)return[];let a=await i.json();return t(a)?a.ads.filter(e):[]}catch{return[]}}function r(e,t,n){e&&fetch(e,{method:`POST`,headers:{"Content-Type":`application/json`},body:JSON.stringify({event:t,...n}),keepalive:!0}).catch(()=>{})}const i=`vjs-ads-overlay-style`;function a(){if(document.getElementById(i))return;let e=document.createElement(`style`);e.id=i,e.textContent=`
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
`,document.head.appendChild(e)}function o(e){return`${Math.floor(e/60)}:${Math.floor(e%60).toString().padStart(2,`0`)}`}const s={skip:`Skip ad`,skipCountdown:e=>`Skip in ${e}s`,timer:(e,t)=>`AD ${e} / ${t}`,mediaAlt:`Advertisement`};var c=class{#e;#t;#n;#r;#i=null;#a=null;#o=!1;#s;constructor(e,t={}){a(),this.#s={...s,...t.labels},this.#e=document.createElement(`div`),this.#e.className=`vjs-ads-overlay`,this.#e.dataset.adPhase=`hidden`,this.#r=document.createElement(`div`),this.#r.style.cssText=`width:100%;height:100%;display:flex;align-items:center;justify-content:center;`,this.#t=document.createElement(`div`),this.#t.className=`vjs-ads-timer`,this.#t.textContent=this.#s.timer(o(0),o(0)),this.#n=document.createElement(`button`),this.#n.className=`vjs-ads-skip`,this.#n.type=`button`,this.#n.dataset.skipAvailable=`false`,this.#n.textContent=this.#s.skip,this.#n.addEventListener(`click`,()=>{this.#n.dataset.skipAvailable===`true`&&this.#a&&this.#a()}),this.#e.appendChild(this.#r),this.#e.appendChild(this.#t),this.#e.appendChild(this.#n),e.appendChild(this.#e)}showAd(e,t){if(this.#c(),e.type===`video`){let n=document.createElement(`video`);n.className=`vjs-ads-media`,n.src=e.src,n.autoplay=!0,n.playsInline=!0,n.muted=!1,t&&n.addEventListener(`click`,t),this.#r.appendChild(n),this.#i=n}else{let n=document.createElement(`img`);n.className=`vjs-ads-media`,n.src=e.src,n.alt=this.#s.mediaAlt,t&&n.addEventListener(`click`,t),this.#r.appendChild(n),this.#i=n}this.#e.dataset.adPhase=`playing`}updateTimer(e,t){this.#t.textContent=this.#s.timer(o(e),o(t))}updateSkip(e,t){this.#n.dataset.skipAvailable=String(e),this.#n.textContent=e?this.#s.skip:this.#s.skipCountdown(t)}onSkip(e){this.#a=e}hide(){this.#c(),this.#e.dataset.adPhase=`hidden`}destroy(){this.#o||(this.#o=!0,this.#c(),this.#e.remove())}#c(){this.#i&&=(this.#i instanceof HTMLVideoElement&&(this.#i.pause(),this.#i.removeAttribute(`src`),this.#i.load()),this.#i.remove(),null)}};export{c as AdsOverlay,n as fetchAds,r as trackAdEvent};
//# sourceMappingURL=videojs-ads.js.map