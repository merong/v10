//#region ../html/dist/default/define/safe-define.js
/**
* Define a custom element only if not already registered.
*
* `tagName` overrides the element's own, for the rare case of registering one
* element under a second name — two flavors of the same element in one runtime,
* say, where whichever registers first would otherwise take the name and the
* other would silently lose it. Registering under the override does not change
* `element.tagName`, so anything reading the class still sees its standard name.
*/
function safeDefine(element, tagName = element.tagName) {
	const registry = globalThis.customElements;
	if (!registry || registry.get(tagName)) return;
	registry.define(tagName, element);
}

//#endregion
//#region ../element/dist/default/destroy-mixin.js
/**
* Mixin that adds a deferred destruction lifecycle to a `ReactiveElement`.
*
* On disconnect, schedules destruction after two animation frames.
* If the element reconnects before the frames fire (e.g. DOM shuffling,
* framework reconciliation), the `isConnected` check prevents destruction.
*
* The `keep-alive` attribute prevents automatic destruction entirely —
* call `destroy()` manually when done.
*
* Subclasses override `destroyCallback()` (calling `super.destroyCallback()`)
* to release heavy resources like stores or imperative APIs.
*
* Mirrors `addController`/`removeController` to track controllers
* (needed because `ReactiveElement.#controllers` is hard-private),
* calls `hostDestroyed()` on all tracked controllers in `destroyCallback`,
* and guards `performUpdate()` so no updates run after destruction.
*/
function DestroyMixin(SuperClass) {
	class DestroyableElement extends SuperClass {
		#destroyed = false;
		#trackedControllers = /* @__PURE__ */ new Set();
		get destroyed() {
			return this.#destroyed;
		}
		destroy() {
			if (this.#destroyed) return;
			this.#destroyed = true;
			this.destroyCallback();
		}
		destroyCallback() {
			for (const c of this.#trackedControllers) c.hostDestroyed?.();
		}
		addController(controller) {
			super.addController(controller);
			this.#trackedControllers.add(controller);
		}
		removeController(controller) {
			super.removeController(controller);
			this.#trackedControllers.delete(controller);
		}
		connectedCallback() {
			if (this.#destroyed) return;
			super.connectedCallback();
		}
		disconnectedCallback() {
			super.disconnectedCallback();
			if (!this.#destroyed && !this.hasAttribute("keep-alive")) requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					if (!this.isConnected) this.destroy();
				});
			});
		}
		performUpdate() {
			if (this.#destroyed) return;
			super.performUpdate();
		}
	}
	return DestroyableElement;
}

//#endregion
//#region ../element/dist/default/reactive-element.js
const cache$1 = /* @__PURE__ */ new WeakMap();
const propertyKeys = /* @__PURE__ */ new Map();
/**
* Lightweight reactive custom element base class.
*
* Drop-in subset of Lit's `ReactiveElement` — supports `static properties`,
* attribute reflection, batched async updates, and reactive controllers.
* No Shadow DOM, no `static styles`, no decorators.
*
* Updates are batched using the same Promise-based scheduling as Lit:
* property changes enqueue a microtask, and the update is gated behind
* `connectedCallback` so the first update only runs once the element
* is in the document.
*
* Subclasses that extend another element with properties must spread them:
*
* @example
* ```ts
* class MyButton extends ReactiveElement {
*   static override properties = {
*     label: { type: String },
*     disabled: { type: Boolean },
*   };
*
*   label = 'Click me';
*   disabled = false;
*
*   protected override update(changed: PropertyValues): void {
*     super.update(changed);
*     this.textContent = this.label;
*   }
* }
*
* // Inheritance — spread parent properties
* class FancyButton extends MyButton {
*   static override properties = {
*     ...MyButton.properties,
*     variant: { type: String },
*   };
*
*   variant = 'primary';
* }
* ```
*/
var ReactiveElement = class extends HTMLElement {
	static {
		this.properties = {};
	}
	/**
	* Returns a list of attributes corresponding to the registered properties.
	*/
	static get observedAttributes() {
		return [...resolve(this).attrToProp.keys()];
	}
	#controllers;
	#changedProperties;
	#instanceProperties;
	/**
	* Promise that gates the first update until `connectedCallback`. Also
	* used to serialize updates — each `#enqueueUpdate` awaits the previous
	* `#updatePromise`, so property changes are batched and updates never
	* overlap. Matches Lit's scheduling model.
	*/
	#updatePromise;
	constructor() {
		super();
		this.#controllers = /* @__PURE__ */ new Set();
		this.#changedProperties = /* @__PURE__ */ new Map();
		this.isUpdatePending = false;
		this.hasUpdated = false;
		this.#updatePromise = new Promise((res) => this.enableUpdating = res);
		const { props } = resolve(this.constructor);
		for (const name of props.keys()) if (Object.hasOwn(this, name)) {
			(this.#instanceProperties ??= /* @__PURE__ */ new Map()).set(name, this[name]);
			delete this[name];
		}
		this.requestUpdate();
	}
	/**
	* Note, this method should be considered final and not overridden. It is
	* overridden on the element instance with a function that triggers the
	* first update.
	*/
	enableUpdating(_requestedUpdate) {}
	/**
	* Registers a {@linkcode ReactiveController} to participate in the
	* element's reactive update cycle. The element automatically calls into
	* any registered controllers during its lifecycle callbacks.
	*
	* If the element is connected when `addController()` is called, the
	* controller's `hostConnected()` callback will be immediately called.
	*/
	addController(controller) {
		this.#controllers.add(controller);
		if (this.isConnected) controller.hostConnected?.();
	}
	/** Removes a {@linkcode ReactiveController} from the element. */
	removeController(controller) {
		this.#controllers.delete(controller);
	}
	/**
	* On first connection, enables updating and notifies controllers.
	*/
	connectedCallback() {
		this.enableUpdating(true);
		for (const c of this.#controllers) c.hostConnected?.();
	}
	disconnectedCallback() {
		for (const c of this.#controllers) c.hostDisconnected?.();
	}
	/**
	* Synchronizes property values when attributes change.
	*
	* Specifically, when an attribute is set, the corresponding property is
	* set. You should rarely need to implement this callback. If this method
	* is overridden, `super.attributeChangedCallback(name, _old, value)` must
	* be called.
	*/
	attributeChangedCallback(attr, oldValue, newValue) {
		if (oldValue === newValue) return;
		const { props, attrToProp } = resolve(this.constructor);
		const propName = attrToProp.get(attr);
		if (!propName) return;
		const decl = props.get(propName);
		if (!decl) return;
		let value = newValue;
		if (decl.type === Boolean) value = newValue !== null;
		else if (decl.type === Number) value = newValue === null ? null : Number(newValue);
		this[propName] = value;
	}
	/**
	* Requests an update which is processed asynchronously. This should be
	* called when an element should update based on some state not triggered
	* by setting a reactive property. In this case, pass no arguments. It
	* should also be called when manually implementing a property setter. In
	* this case, pass the property `name` and `oldValue` to ensure that any
	* configured property options are honored.
	*/
	requestUpdate(name, oldValue) {
		if (name !== void 0) this.#changedProperties.set(name, oldValue);
		if (this.isUpdatePending) return;
		this.#updatePromise = this.#enqueueUpdate();
	}
	/**
	* Sets up the element to asynchronously update. Awaits the previous
	* `#updatePromise` which both serializes updates and (on first update)
	* waits for `connectedCallback` to resolve the gate.
	*/
	async #enqueueUpdate() {
		this.isUpdatePending = true;
		try {
			await this.#updatePromise;
		} catch (e) {
			Promise.reject(e);
		}
		const result = this.scheduleUpdate();
		if (result != null) await result;
		return !this.isUpdatePending;
	}
	/**
	* Schedules an element update. You can override this method to change the
	* timing of updates by returning a Promise. The update will await the
	* returned Promise, and you should resolve the Promise to allow the update
	* to proceed. If this method is overridden, `super.scheduleUpdate()` must
	* be called.
	*
	* For instance, to schedule updates to occur just before the next frame:
	*
	* ```ts
	* override protected async scheduleUpdate(): Promise<unknown> {
	*   await new Promise((resolve) => requestAnimationFrame(() => resolve()));
	*   super.scheduleUpdate();
	* }
	* ```
	*/
	scheduleUpdate() {
		this.performUpdate();
	}
	/**
	* Performs an element update. Note, if an exception is thrown during the
	* update, `firstUpdated` and `updated` will not be called.
	*
	* Call `performUpdate()` to immediately process a pending update. This
	* should generally not be needed, but it can be done in rare cases when
	* you need to update synchronously.
	*/
	performUpdate() {
		if (!this.isUpdatePending) return;
		if (!this.hasUpdated && this.#instanceProperties) {
			for (const [name, value] of this.#instanceProperties) this[name] = value;
			this.#instanceProperties = void 0;
		}
		const changed = this.#changedProperties;
		this.willUpdate(changed);
		for (const c of this.#controllers) c.hostUpdate?.();
		this.update(changed);
		this.#changedProperties = /* @__PURE__ */ new Map();
		this.isUpdatePending = false;
		for (const c of this.#controllers) c.hostUpdated?.();
		if (!this.hasUpdated) {
			this.hasUpdated = true;
			this.firstUpdated(changed);
		}
		this.updated(changed);
	}
	/**
	* Invoked before `update()` to compute values needed during the update.
	*
	* Implement `willUpdate` to compute property values that depend on other
	* properties and are used in the rest of the update process.
	*
	* ```ts
	* willUpdate(changed) {
	*   if (changed.has('firstName') || changed.has('lastName')) {
	*     this.sha = computeSHA(`${this.firstName} ${this.lastName}`);
	*   }
	* }
	* ```
	*/
	willUpdate(_changed) {}
	/**
	* Updates the element. This method reflects property values to attributes
	* and can be overridden to render and keep updated element DOM. Setting
	* properties inside this method will *not* trigger another update.
	*/
	update(_changed) {}
	/**
	* Invoked when the element is first updated. Implement to perform one
	* time work on the element after update.
	*
	* Setting properties inside this method will trigger the element to
	* update again after this update cycle completes.
	*/
	firstUpdated(_changed) {}
	/**
	* Invoked whenever the element is updated. Implement to perform
	* post-updating tasks via DOM APIs, for example, focusing an element.
	*
	* Setting properties inside this method will trigger the element to
	* update again after this update cycle completes.
	*/
	updated(_changed) {}
	/**
	* Returns a Promise that resolves when the element has completed updating.
	* The Promise value is a boolean that is `true` if the element completed
	* the update without triggering another update. The Promise result is
	* `false` if a property was set inside `updated()`.
	*/
	get updateComplete() {
		return this.#updatePromise;
	}
};
/**
* Resolve `ctor.properties` into lookup Maps and install reactive accessors
* on the prototype. Runs once per class, result is cached.
*
* Subclasses that need parent properties must spread them:
* `static override properties = { ...Parent.properties, ... }`.
*/
function resolve(ctor) {
	const existing = cache$1.get(ctor);
	if (existing) return existing;
	const props = /* @__PURE__ */ new Map();
	const attrToProp = /* @__PURE__ */ new Map();
	for (const [name, decl] of Object.entries(ctor.properties)) {
		props.set(name, decl);
		attrToProp.set(decl.attribute ?? name, name);
		if (!Object.getOwnPropertyDescriptor(ctor.prototype, name)?.get) {
			let key = propertyKeys.get(name);
			if (!key) {
				key = Symbol(name);
				propertyKeys.set(name, key);
			}
			Object.defineProperty(ctor.prototype, name, {
				get() {
					return this[key];
				},
				set(value) {
					const old = this[key];
					this[key] = value;
					if (!Object.is(old, value)) this.requestUpdate(name, old);
				},
				configurable: true,
				enumerable: true
			});
		}
	}
	const meta = {
		props,
		attrToProp
	};
	cache$1.set(ctor, meta);
	return meta;
}

//#endregion
//#region ../html/dist/default/ui/media-element.js
/** Base class for interactive media UI elements. */
var MediaElement = class extends DestroyMixin(ReactiveElement) {};

//#endregion
//#region ../../node_modules/.pnpm/@lit+context@1.1.6/node_modules/@lit/context/lib/context-request-event.js
/**
* @license
* Copyright 2021 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/
var s$2 = class extends Event {
	constructor(s, t, e, o) {
		super("context-request", {
			bubbles: !0,
			composed: !0
		}), this.context = s, this.contextTarget = t, this.callback = e, this.subscribe = o ?? !1;
	}
};

//#endregion
//#region ../../node_modules/.pnpm/@lit+context@1.1.6/node_modules/@lit/context/lib/create-context.js
/**
* @license
* Copyright 2021 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/
function n(n) {
	return n;
}

//#endregion
//#region ../../node_modules/.pnpm/@lit+context@1.1.6/node_modules/@lit/context/lib/controllers/context-consumer.js
/**
* @license
* Copyright 2021 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/ var s$1 = class {
	constructor(t, s, i, h) {
		if (this.subscribe = !1, this.provided = !1, this.value = void 0, this.t = (t, s) => {
			this.unsubscribe && (this.unsubscribe !== s && (this.provided = !1, this.unsubscribe()), this.subscribe || this.unsubscribe()), this.value = t, this.host.requestUpdate(), this.provided && !this.subscribe || (this.provided = !0, this.callback && this.callback(t, s)), this.unsubscribe = s;
		}, this.host = t, void 0 !== s.context) {
			const t = s;
			this.context = t.context, this.callback = t.callback, this.subscribe = t.subscribe ?? !1;
		} else this.context = s, this.callback = i, this.subscribe = h ?? !1;
		this.host.addController(this);
	}
	hostConnected() {
		this.dispatchRequest();
	}
	hostDisconnected() {
		this.unsubscribe && (this.unsubscribe(), this.unsubscribe = void 0);
	}
	dispatchRequest() {
		this.host.dispatchEvent(new s$2(this.context, this.host, this.t, this.subscribe));
	}
};

//#endregion
//#region ../../node_modules/.pnpm/@lit+context@1.1.6/node_modules/@lit/context/lib/value-notifier.js
/**
* @license
* Copyright 2021 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/
var s = class {
	get value() {
		return this.o;
	}
	set value(s) {
		this.setValue(s);
	}
	setValue(s, t = !1) {
		const i = t || !Object.is(s, this.o);
		this.o = s, i && this.updateObservers();
	}
	constructor(s) {
		this.subscriptions = /* @__PURE__ */ new Map(), this.updateObservers = () => {
			for (const [s, { disposer: t }] of this.subscriptions) s(this.o, t);
		}, void 0 !== s && (this.value = s);
	}
	addCallback(s, t, i) {
		if (!i) return void s(this.value);
		this.subscriptions.has(s) || this.subscriptions.set(s, {
			disposer: () => {
				this.subscriptions.delete(s);
			},
			consumerHost: t
		});
		const { disposer: h } = this.subscriptions.get(s);
		s(this.value, h);
	}
	clearCallbacks() {
		this.subscriptions.clear();
	}
};

//#endregion
//#region ../../node_modules/.pnpm/@lit+context@1.1.6/node_modules/@lit/context/lib/controllers/context-provider.js
/**
* @license
* Copyright 2021 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/ var e = class extends Event {
	constructor(t, s) {
		super("context-provider", {
			bubbles: !0,
			composed: !0
		}), this.context = t, this.contextTarget = s;
	}
};
var i = class extends s {
	constructor(s, e, i) {
		super(void 0 !== e.context ? e.initialValue : i), this.onContextRequest = (t) => {
			if (t.context !== this.context) return;
			const s = t.contextTarget ?? t.composedPath()[0];
			s !== this.host && (t.stopPropagation(), this.addCallback(t.callback, s, t.subscribe));
		}, this.onProviderRequest = (s) => {
			if (s.context !== this.context) return;
			if ((s.contextTarget ?? s.composedPath()[0]) === this.host) return;
			const e = /* @__PURE__ */ new Set();
			for (const [s, { consumerHost: i }] of this.subscriptions) e.has(s) || (e.add(s), i.dispatchEvent(new s$2(this.context, i, s, !0)));
			s.stopPropagation();
		}, this.host = s, void 0 !== e.context ? this.context = e.context : this.context = e, this.attachListeners(), this.host.addController?.(this);
	}
	attachListeners() {
		this.host.addEventListener("context-request", this.onContextRequest), this.host.addEventListener("context-provider", this.onProviderRequest);
	}
	hostConnected() {
		this.host.dispatchEvent(new e(this.context, this.host));
	}
};

//#endregion
//#region ../html/dist/default/i18n/context.js
const I18N_CONTEXT_KEY = Symbol.for("@videojs/i18n");
/**
* The default i18n context instance for consuming the player store in controllers.
*
* @public
*/
const i18nContext = n(I18N_CONTEXT_KEY);

//#endregion
//#region ../core/dist/default/i18n/locales/en.js
var en_default = {
	buttons: {
		play: "Play",
		pause: "Pause",
		replay: "Replay",
		mute: "Mute",
		unmute: "Unmute"
	},
	seek: {
		forward: "Seek forward {seconds} seconds",
		backward: "Seek backward {seconds} seconds"
	},
	fullscreen: {
		enter: "Enter fullscreen",
		exit: "Exit fullscreen"
	},
	captions: {
		enable: "Enable captions",
		disable: "Disable captions"
	},
	pip: {
		enter: "Enter picture-in-picture",
		exit: "Exit picture-in-picture"
	},
	live: {
		playing: "Playing live",
		seekToEdge: "Seek to live edge",
		badge: "Live"
	},
	cast: {
		start: "Start casting",
		stop: "Stop casting",
		connecting: "Connecting"
	},
	airplay: {
		start: "Start AirPlay",
		stop: "Stop AirPlay"
	},
	slider: { seek: "Seek" },
	time: {
		current: "Current time",
		duration: "Duration",
		remaining: "Remaining",
		elapsedSuffix: "{duration} elapsed",
		durationSuffix: "{duration} duration",
		remainingSuffix: "{duration} remaining",
		showElapsed: "Show elapsed time, {duration}.",
		showDuration: "Show duration, {duration}.",
		showRemaining: "Show remaining time, {duration}.",
		toggleElapsed: "Toggle between elapsed and remaining time.",
		toggleDuration: "Toggle between duration and remaining time.",
		position: "{current} of {duration}"
	},
	playback: { rate: "Playback rate {rate}" },
	volume: {
		mutedValue: "{percent}, muted",
		muted: "Muted",
		label: "Volume",
		value: "Volume {value}"
	},
	status: {
		captionsOn: "Captions on",
		captionsOff: "Captions off",
		paused: "Paused",
		playing: "Playing",
		fullscreen: "Fullscreen",
		pip: "Picture in picture",
		exitPip: "Exit picture in picture",
		seekedTo: "Seeked to {time}"
	},
	container: { label: "Media player" },
	errors: {
		aborted: "You stopped media playback before it finished.",
		network: "This media could not be loaded due to a network or server issue.",
		decode: "This media could not be played. It may be corrupted, or your browser may not support its format.",
		source: "This media could not be loaded. It may be unavailable, or your browser may not support its format.",
		encrypted: "This media could not be played because it could not be decrypted.",
		unplayable: "This media is unsupported by the player.",
		title: "Something went wrong.",
		unexpected: "An unexpected error occurred."
	},
	common: {
		empty: "",
		ok: "OK"
	},
	menu: {
		settings: "Settings",
		quality: "Quality",
		audio: "Audio",
		default: "Default",
		speed: "Speed",
		captions: "Captions",
		playbackRate: "Playback rate",
		back: "Back",
		off: "Off",
		auto: "Auto",
		autoWithLabel: "Auto ({label})",
		subtitles: "Subtitles"
	}
};

//#endregion
//#region ../utils/dist/predicate/predicate.js
function isString(value) {
	return typeof value === "string";
}
function isNumber(value) {
	return typeof value === "number";
}
function isBoolean(value) {
	return typeof value === "boolean";
}
function isFunction(value) {
	return typeof value === "function";
}
function isNull(value) {
	return value === null;
}
function isUndefined(value) {
	return typeof value === "undefined";
}
/**
* Check if a value is an object, excluding null.
*/
function isObject(value) {
	return value !== null && typeof value === "object";
}

//#endregion
//#region ../utils/dist/object/defaults.js
/**
* Creates a new object with default values filled in for undefined properties.
*
* Only keys owned by `defaultValues` are read from `object`; any other key on
* `object` is ignored. Callers pass live DOM elements as `object`, and
* enumerating those would touch hundreds of inherited accessors such as
* `offsetWidth` and `innerHTML`, forcing style recalculation and layout on
* every call.
*
* @example
* ```ts
* const props = { label: undefined, disabled: true };
* const defaultProps = { label: '', disabled: false };
* defaults(props, defaultProps); // { label: '', disabled: true }
* ```
*/
function defaults(object, defaultValues) {
	const result = { ...defaultValues };
	for (const key of Object.keys(defaultValues)) {
		const value = object[key];
		if (!isUndefined(value)) result[key] = value;
	}
	return result;
}

//#endregion
//#region ../utils/dist/object/flatten.js
function flatten(object, options = {}) {
	const { prefix = "" } = options;
	const result = {};
	for (const [key, value] of Object.entries(object)) {
		const fullKey = prefix ? `${prefix}.${key}` : key;
		if (value !== null && typeof value === "object" && !Array.isArray(value)) Object.assign(result, flatten(value, { prefix: fullKey }));
		else result[fullKey] = value;
	}
	return result;
}

//#endregion
//#region ../utils/dist/object/pick.js
/**
* Creates a new object with only the specified keys.
*
* @example
* const obj = { a: 1, b: 2, c: 3 };
* pick(obj, ['a', 'c']); // { a: 1, c: 3 }
*/
function pick(obj, keys) {
	const result = {};
	for (const key of keys) if (Object.hasOwn(obj, key)) result[key] = obj[key];
	return result;
}

//#endregion
//#region ../utils/dist/object/shallow-equal.js
const hasOwn = Object.prototype.hasOwnProperty;
/** Shallowly compares values, including own string and symbol keys. */
function shallowEqual(a, b) {
	if (Object.is(a, b)) return true;
	if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return false;
	const keysA = Reflect.ownKeys(a);
	const keysB = Reflect.ownKeys(b);
	if (keysA.length !== keysB.length) return false;
	for (const key of keysA) if (!hasOwn.call(b, key) || !Object.is(a[key], b[key])) return false;
	return true;
}

//#endregion
//#region ../core/dist/default/core/i18n/utils/flatten.js
function flattenTranslations(locale, options = {}) {
	return flatten(locale, options);
}

//#endregion
//#region ../core/dist/default/core/i18n/registry.js
/**
* Well-known key for the shared registry. Its name and value shape are a cross-version contract:
* every copy of this module in a realm must agree on them, so change the key when the shape changes.
*/
const I18N_REGISTRY_KEY = Symbol.for("@videojs/i18n-registry");
/**
* The registry is realm-global rather than module-global so duplicate copies of this module
* converge on one set of translations.
*
* Duplication is normal, not a bug to fix upstream: separately loaded CDN bundles, a pinned and an
* unpinned URL for the same file, and two bundlers' output on one page all yield distinct module
* instances. With module-scoped state, a `registerI18n` call on one instance is invisible to the
* player reading from another, and the locale silently falls back to English.
*/
function getRegistry() {
	const host = globalThis;
	const existing = host[I18N_REGISTRY_KEY];
	if (existing) return existing;
	const registry = {
		layers: /* @__PURE__ */ new Map(),
		subscribers: /* @__PURE__ */ new Set()
	};
	host[I18N_REGISTRY_KEY] = registry;
	return registry;
}
function notify() {
	for (const cb of getRegistry().subscribers) cb();
}
function normalizeLocaleTag(tag) {
	return tag.trim().replaceAll("_", "-").toLowerCase();
}
/** Strip unicode locale extension sequences (`-u-…`) before any private-use `-x-` block. */
function stripUnicodeExtensions(tag) {
	const xIdx = tag.indexOf("-x-");
	const uIdx = (xIdx === -1 ? tag : tag.slice(0, xIdx)).indexOf("-u-");
	if (uIdx === -1) return tag;
	return tag.slice(0, uIdx) + (xIdx === -1 ? "" : tag.slice(xIdx));
}
function chineseFallback(segments) {
	if (segments[0] !== "zh") return;
	const script = segments.find((segment) => segment === "hant" || segment === "hans");
	return script === "hant" ? "zh-tw" : script === "hans" ? "zh-cn" : void 0;
}
/** Registry map key: normalized tag with unicode extensions removed (same base as {@link findLocaleKeys}). */
function getCanonicalLocaleKey(locale) {
	return stripUnicodeExtensions(normalizeLocaleTag(locale));
}
/**
* Most-specific-first BCP 47 lookup tags (normalized). Always ends with `en` when missing from the truncated chain.
*
* @example `es-419-u-nu-latn` → `['es-419', 'es', 'en']`
*/
function findLocaleKeys(locale) {
	const base = getCanonicalLocaleKey(locale);
	if (!base) return ["en"];
	const segments = base.split("-").filter(Boolean);
	const chain = [];
	for (let len = segments.length; len >= 1; len--) chain.push(segments.slice(0, len).join("-"));
	const zhFallback = chineseFallback(segments);
	const zhIndex = chain.indexOf("zh");
	if (zhFallback && zhIndex !== -1) chain.splice(zhIndex, 0, zhFallback);
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	for (const tag of chain) if (!seen.has(tag)) {
		seen.add(tag);
		out.push(tag);
	}
	if (!seen.has("en")) out.push("en");
	return out;
}
function mergeI18nTranslations(chain) {
	const { layers } = getRegistry();
	const merged = {};
	for (let i = chain.length - 1; i >= 0; i--) {
		const tag = chain[i];
		const layer = layers.get(tag);
		if (layer) Object.assign(merged, layer);
	}
	return merged;
}
/**
* Register or merge translation strings for a BCP 47 locale tag.
*
* @param locale - BCP 47 tag (normalized to lowercase; unicode extensions stripped for the registry key).
* @param translations - Partial nested locale values; merges with any existing layer for the tag.
* @public
*/
function registerI18n(locale, translations) {
	const { layers } = getRegistry();
	const tag = getCanonicalLocaleKey(locale);
	const existing = layers.get(tag) ?? {};
	layers.set(tag, {
		...existing,
		...flattenTranslations(translations)
	});
	notify();
}
/**
* Return the merged registered translation map for a locale. Built-in English defaults are supplied by text descriptors.
*
* @param locale - BCP 47 tag to resolve (e.g. `es-MX`, `zh-Hant-HK`).
* @public
*/
function getI18nTranslations(locale) {
	return mergeI18nTranslations(findLocaleKeys(locale));
}
/**
* Subscribe to global registry mutations (for example after `registerI18n` or browser translation prefetch).
*
* @param callback - Invoked when any locale layer changes.
* @public
*/
function onI18nRegistryChange(callback) {
	const { subscribers } = getRegistry();
	subscribers.add(callback);
	return () => {
		subscribers.delete(callback);
	};
}
/**
* Whether an exact locale tag has been registered via `registerI18n` (not whether lazy packs exist).
*
* @param locale - BCP 47 tag to test.
* @public
*/
function hasRegisteredLocale(locale) {
	return getRegistry().layers.has(getCanonicalLocaleKey(locale));
}

//#endregion
//#region ../core/dist/default/core/i18n/browser-translation.js
const NAMED_PLACEHOLDER = /\{([^{}]+)\}/g;
const INDEX_PLACEHOLDER = /\{\s*(\d+)\s*\}/g;
/**
* Replaces `{seconds}` with `{0}`, `{1}`, … so the Browser Translation API sees one full
* sentence (grammar/word order preserved) while opaque numeric slots are left alone.
*/
function maskNamedPlaceholders(source) {
	const slots = [];
	return {
		masked: source.replace(NAMED_PLACEHOLDER, (_, name) => {
			slots.push(name);
			return `{${slots.length - 1}}`;
		}),
		slots
	};
}
function restoreNamedPlaceholders(translated, slots) {
	return translated.replace(INDEX_PLACEHOLDER, (match, index) => {
		const name = slots[Number(index)];
		return name !== void 0 ? `{${name}}` : match;
	});
}
async function translateProtectingPlaceholders(translator, value) {
	const { masked, slots } = maskNamedPlaceholders(value);
	if (slots.length === 0) return translator.translate(value);
	return restoreNamedPlaceholders(await translator.translate(masked), slots);
}
const cache = /* @__PURE__ */ new Map();
function isEnglishLocaleTag(tag) {
	return tag === "en" || tag.startsWith(`${"en"}-`);
}
function getBrowserTranslator() {
	if (!("Translator" in globalThis)) return void 0;
	return globalThis.Translator;
}
/** First non-English tag in the lookup chain used as the browser translation target. */
function resolveBrowserTranslationTarget(locale) {
	for (const tag of findLocaleKeys(locale)) if (!isEnglishLocaleTag(tag)) return tag;
}
/** Whether to invoke the Browser Translation API for this locale after lazy built-in loading. */
function shouldAttemptBrowserTranslation(locale, loadedLazyTags, translations) {
	if (!resolveBrowserTranslationTarget(locale)) return false;
	if (loadedLazyTags.some((tag) => !isEnglishLocaleTag(tag))) return translations !== void 0 && hasMissingEnglishTranslations(translations);
	return !findLocaleKeys(locale).some((tag) => !isEnglishLocaleTag(tag) && hasRegisteredLocale(tag));
}
function hasMissingEnglishTranslations(translations) {
	const english = flattenTranslations(en_default);
	return Object.keys(english).some((key) => translations[key] === void 0);
}
/**
* Translates English registry values via the on-device Browser Translation API when a pre-installed
* model is available. Results are cached per target language tag.
*/
async function getBrowserTranslations(locale, options) {
	const target = resolveBrowserTranslationTarget(locale);
	if (!target) return {};
	const cached = cache.get(target);
	if (cached) return cached;
	const Translator = getBrowserTranslator();
	if (!Translator) return {};
	const downloadIfNeeded = options?.downloadIfNeeded ?? false;
	const availability = await Translator.availability({
		sourceLanguage: "en",
		targetLanguage: target
	});
	if (availability === "unavailable") return {};
	if (!downloadIfNeeded && availability !== "available") return {};
	const needsDownload = downloadIfNeeded && (availability === "downloadable" || availability === "downloading");
	let downloadStarted = false;
	const notifyDownloadStart = () => {
		if (!needsDownload || downloadStarted) return;
		downloadStarted = true;
		options?.onModelDownload?.start?.(target);
	};
	notifyDownloadStart();
	const english = flattenTranslations(en_default);
	const keys = Object.keys(english);
	const translator = await Translator.create({
		sourceLanguage: "en",
		targetLanguage: target,
		...downloadIfNeeded ? { monitor(monitor) {
			monitor.addEventListener("downloadprogress", notifyDownloadStart);
		} } : {}
	});
	if (downloadStarted) options?.onModelDownload?.finish?.(target);
	const entries = await Promise.all(keys.map(async (key) => {
		const value = english[key];
		if (!value) return [key, ""];
		return [key, await translateProtectingPlaceholders(translator, value)];
	}));
	const result = Object.fromEntries(entries);
	cache.set(target, result);
	return result;
}

//#endregion
//#region ../core/dist/default/core/i18n/load-locale.js
const loaders = {
	ar: () => import("./ar-spejag4I.js"),
	az: () => import("./az-Cu7hGE3r.js"),
	bs: () => import("./bs-BuaapmfN.js"),
	bg: () => import("./bg-UzGLjRGh.js"),
	bn: () => import("./bn-BpfN-g_s.js"),
	ca: () => import("./ca-D7bF2coJ.js"),
	cs: () => import("./cs-89tcHUWm.js"),
	cy: () => import("./cy-4ssTDolW.js"),
	da: () => import("./da-DVeO5Xzn.js"),
	de: () => import("./de-D5a0T7C7.js"),
	el: () => import("./el-BPFqzrR1.js"),
	es: () => import("./es-CJzV7-iV.js"),
	et: () => import("./et-B5Zd1PeX.js"),
	eu: () => import("./eu-DF9__1TE.js"),
	fa: () => import("./fa-Bdrc-DBD.js"),
	fi: () => import("./fi-CWiFy53d.js"),
	fr: () => import("./fr-CptRCkUf.js"),
	gd: () => import("./gd-7jsQUEym.js"),
	gl: () => import("./gl-CG7Xm2Og.js"),
	he: () => import("./he-CFITRf7w.js"),
	hi: () => import("./hi-Ba2ghNLU.js"),
	hr: () => import("./hr-DNbiCfdA.js"),
	hu: () => import("./hu-DtXfGNml.js"),
	id: () => import("./id-_oZqoW0-.js"),
	it: () => import("./it-kdTEdLMc.js"),
	ja: () => import("./ja-CAMKtZ2D.js"),
	ko: () => import("./ko-C6TOgWsA.js"),
	lt: () => import("./lt-BatRq3EV.js"),
	lv: () => import("./lv-Bd3sGGDm.js"),
	mr: () => import("./mr-CLx5U_7m.js"),
	nb: () => import("./nb-Cwxnd3TG.js"),
	nl: () => import("./nl-c8uFU8u0.js"),
	nn: () => import("./nn-DIUj6G2x.js"),
	ne: () => import("./ne-Dei5KxvA.js"),
	oc: () => import("./oc-DftCBS1S.js"),
	pl: () => import("./pl-QHj8Nh8v.js"),
	"pt-br": () => import("./pt-BR-CeI492uQ.js"),
	"pt-pt": () => import("./pt-PT-BnqN-42M.js"),
	ro: () => import("./ro-BAHWaLTs.js"),
	ru: () => import("./ru-CU_1EiV9.js"),
	sk: () => import("./sk-CigxuN7N.js"),
	sl: () => import("./sl-DOB6WTXy.js"),
	sr: () => import("./sr-D4BA_RNX.js"),
	sv: () => import("./sv-BV6AiKpl.js"),
	te: () => import("./te-BvgAsNyD.js"),
	th: () => import("./th-ny-O-FUP.js"),
	tr: () => import("./tr-CPboRKZn.js"),
	uk: () => import("./uk-Ca06VGNG.js"),
	vi: () => import("./vi-BWvvmJr2.js"),
	"zh-cn": () => import("./zh-CN-B7XVF81j.js"),
	"zh-tw": () => import("./zh-TW-ftKwuF6F.js"),
	pt: () => import("./pt-D1k6vBxI.js"),
	zh: () => import("./zh-D2El06PK.js")
};
/** Lazy-import a shipped locale pack when the tag is not already in the registry. */
async function loadLocale(tag) {
	if (hasRegisteredLocale(tag)) return void 0;
	for (const chainTag of findLocaleKeys(tag)) {
		if (hasRegisteredLocale(chainTag)) return void 0;
		const load = loaders[getCanonicalLocaleKey(chainTag)];
		if (load) return flattenTranslations((await load()).default);
	}
}

//#endregion
//#region ../core/dist/default/core/i18n/resolve-text.js
function resolveText(text) {
	return typeof text === "string" ? text : text.text;
}

//#endregion
//#region ../core/dist/default/core/i18n/text.js
function isText(value) {
	return isObject(value) && "key" in value && "text" in value;
}

//#endregion
//#region ../core/dist/default/core/i18n/utils/interpolate.js
const PLACEHOLDER = /\{([^{}]+)\}/g;
function interpolate(template, params) {
	if (!params) return template;
	return template.replace(PLACEHOLDER, (match, name) => {
		return Object.hasOwn(params, name) ? String(params[name]) : match;
	});
}

//#endregion
//#region ../core/dist/default/core/i18n/translate-text.js
function translateText(text, translatorOrParams, params) {
	if (typeof text === "string") return text;
	if (typeof translatorOrParams === "function") return translatorOrParams(text, params);
	return interpolate(resolveText(text), translatorOrParams ?? params);
}

//#endregion
//#region ../core/dist/default/core/i18n/translator.js
/**
* Builds a typed translator from a resolved translation map (typically from `getI18nTranslations`).
*
* @param translations - Merged translation map for the active locale.
* @param locale - BCP 47 tag associated with the map (reserved for future locale-aware behavior).
* @public
*/
function createTranslator(translations, locale) {
	const translate = (input, params) => {
		const options = params;
		const isDescriptor = typeof input !== "string";
		const key = isDescriptor ? input.key : input;
		const translation = translations[key];
		const fallback = options?.default;
		const values = options ? { ...options } : void 0;
		if (values) delete values.default;
		return interpolate(translation ?? (isDescriptor ? input.text : fallback) ?? String(key), values);
	};
	return translate;
}

//#endregion
//#region ../html/dist/default/i18n/controller.js
let fallbackTranslator;
function getFallbackTranslator() {
	fallbackTranslator ??= createTranslator(getI18nTranslations("en"), "en");
	return fallbackTranslator;
}
var I18nController = class {
	#host;
	#consumer;
	#unsubscribeRegistry;
	constructor(host, context) {
		this.#host = host;
		this.#consumer = new s$1(host, {
			context,
			callback: () => this.#host.requestUpdate(),
			subscribe: true
		});
		host.addController(this);
	}
	get value() {
		return this.#consumer.value?.translator ?? getFallbackTranslator();
	}
	get locale() {
		return this.#consumer.value?.locale ?? "en";
	}
	hostConnected() {
		fallbackTranslator = void 0;
		this.#unsubscribeRegistry = onI18nRegistryChange(() => {
			fallbackTranslator = void 0;
			if (!this.#consumer.value) this.#host.requestUpdate();
		});
	}
	hostDisconnected() {
		this.#unsubscribeRegistry?.();
		this.#unsubscribeRegistry = void 0;
	}
};

//#endregion
//#region ../html/dist/default/player/context.js
const PLAYER_CONTEXT_KEY = Symbol.for("@videojs/player");
/**
* The default player context instance for consuming the player store in controllers.
*
* @public
*/
const playerContext = n(PLAYER_CONTEXT_KEY);
const MEDIA_CONTEXT_KEY = Symbol.for("@videojs/media");
const mediaContext = n(MEDIA_CONTEXT_KEY);
const CONTAINER_CONTEXT_KEY = Symbol.for("@videojs/container");
const containerContext = n(CONTAINER_CONTEXT_KEY);

//#endregion
//#region ../html/dist/default/player/popup-group-context.js
const popupGroupContext = n(Symbol.for("@videojs/popup-group"));

//#endregion
//#region ../utils/dist/events/abort.js
/**
* Compose multiple abort signals into one that aborts when **any** input fires.
* Uses native `AbortSignal.any` when available, otherwise falls back to a
* manual `AbortController` composition for Chromium ≤115 and similar runtimes.
*/
function anyAbortSignal(signals) {
	if ("any" in AbortSignal) return AbortSignal.any(signals);
	const controller = new AbortController();
	for (const signal of signals) {
		if (signal.aborted) {
			controller.abort(signal.reason);
			return controller.signal;
		}
		signal.addEventListener("abort", () => controller.abort(signal.reason), { signal: controller.signal });
	}
	return controller.signal;
}

//#endregion
//#region ../store/dist/default/core/abort-controller-registry.js
var AbortControllerRegistry = class {
	#base;
	#keys = /* @__PURE__ */ new Map();
	/** The attach-scoped signal. Aborts on detach or reattach. */
	get base() {
		return (this.#base ??= new AbortController()).signal;
	}
	/** Clears all keyed signals, leaving base intact. */
	clear() {
		for (const controller of this.#keys.values()) controller.abort();
		this.#keys.clear();
	}
	/** Resets base and clears all keyed signals. */
	reset() {
		this.clear();
		this.#base?.abort();
		this.#base = void 0;
	}
	/** Creates a new signal for the key, superseding any previous signal. */
	supersede(key) {
		this.#keys.get(key)?.abort();
		const controller = new AbortController();
		this.#keys.set(key, controller);
		return anyAbortSignal([this.base, controller.signal]);
	}
};

//#endregion
//#region ../store/dist/default/core/combine.js
/**
* Combines multiple slices into a single slice.
*
* @param slices - The slices to combine.
* @returns A new slice that represents the combination of the input slices.
*/
function combine(...slices) {
	const derivedDefinitions = slices.map((slice) => slice.derived ?? {});
	return {
		state: (ctx) => {
			const states = slices.map((slice) => slice.state(ctx));
			return Object.assign({}, ...states);
		},
		preserve: Array.from(new Set(slices.flatMap((slice) => slice.preserve ?? []))),
		derived: Object.assign({}, ...derivedDefinitions),
		attach: (ctx) => {
			for (const slice of slices) try {
				slice.attach?.(ctx);
			} catch (err) {
				ctx.reportError(err);
			}
		}
	};
}

//#endregion
//#region ../store/dist/default/core/errors.js
var StoreError = class extends Error {
	code;
	cause;
	constructor(code, options) {
		super(options?.message ?? code);
		this.name = "StoreError";
		this.code = code;
		this.cause = options?.cause;
	}
};
function throwNoTargetError() {
	throw new StoreError("NO_TARGET");
}
function throwDestroyedError() {
	throw new StoreError("DESTROYED");
}

//#endregion
//#region ../store/dist/default/core/selector.js
const stateContext = {
	target: throwNoTargetError,
	signals: new AbortControllerRegistry(),
	get: throwNoTargetError,
	set: throwNoTargetError
};
/**
* Create a type-safe selector for a slice's state.
*
* The selector returns the slice's state, or `undefined` if the slice
* is not configured in the store.
*
* @example
* ```ts
* const selectPlayback = createSelector(playbackSlice);
* selectPlayback(store.state); // { paused, play, pause, ... } | undefined
* selectPlayback.displayName;  // 'playback' (from slice name)
* ```
*
* @param slice - The slice to create a selector for.
*/
function createSelector(slice) {
	const initialState = slice.state(stateContext);
	const keys = [...Object.keys(initialState), ...Object.keys(slice.derived ?? {})];
	const firstKey = keys[0];
	if (!firstKey) return Object.assign(() => void 0, { displayName: slice.name });
	return Object.assign((state) => {
		if (!(firstKey in state)) return void 0;
		return pick(state, keys);
	}, { displayName: slice.name });
}

//#endregion
//#region ../store/dist/default/core/slice.js
function defineSlice() {
	return ((config) => config);
}

//#endregion
//#region ../utils/dist/function/noop.js
function noop(..._args) {}

//#endregion
//#region ../utils/dist/function/throttle.js
/**
* Throttle: limits `fn` to at most once per `ms` window.
*
* - Default (no options): trailing-edge only — the first call schedules a
*   timer; subsequent calls within the window update the arguments. The
*   function fires once per window with the latest arguments.
* - `{ leading: true }`: leading + trailing — the first call invokes
*   immediately and opens a cooldown window. Subsequent calls within the
*   window are coalesced to a single trailing-edge invocation.
*/
function throttle(fn, ms, options) {
	const leading = options?.leading ?? false;
	let timerId = null;
	let latestArgs;
	let hasPending = false;
	function startCooldown() {
		timerId = setTimeout(() => {
			timerId = null;
			if (hasPending) {
				hasPending = false;
				fn(...latestArgs);
				startCooldown();
			}
		}, ms);
	}
	const throttled = (...args) => {
		latestArgs = args;
		if (leading) if (timerId === null) {
			fn(...latestArgs);
			startCooldown();
		} else hasPending = true;
		else {
			if (timerId !== null) return;
			timerId = setTimeout(() => {
				timerId = null;
				fn(...latestArgs);
			}, ms);
		}
	};
	throttled.cancel = () => {
		if (timerId !== null) {
			clearTimeout(timerId);
			timerId = null;
		}
		hasPending = false;
	};
	return throttled;
}

//#endregion
//#region ../store/dist/default/core/state.js
let isFlushScheduled = false;
function scheduleFlush() {
	if (isFlushScheduled) return;
	isFlushScheduled = true;
	queueMicrotask(flush$1);
}
const pendingContainers = /* @__PURE__ */ new Set();
function flush$1() {
	isFlushScheduled = false;
	for (const container of pendingContainers) container.flush();
	pendingContainers.clear();
}
const hasOwnProp$1 = Object.prototype.hasOwnProperty;
var StateContainer = class {
	#current;
	#listeners = /* @__PURE__ */ new Set();
	#pending = false;
	constructor(initial) {
		this.#current = Object.freeze({ ...initial });
	}
	get current() {
		return this.#current;
	}
	patch(partial) {
		const next = { ...this.#current };
		let changed = false;
		for (const key of Reflect.ownKeys(partial)) {
			if (!hasOwnProp$1.call(partial, key)) continue;
			const value = partial[key];
			if (!Object.is(this.#current[key], value)) {
				next[key] = value;
				changed = true;
			}
		}
		if (changed) {
			this.#current = Object.freeze(next);
			this.#markPending();
		}
	}
	replace(next) {
		if (shallowEqual(this.#current, next)) return;
		this.#current = Object.freeze({ ...next });
		this.#markPending();
	}
	subscribe(callback, options) {
		const signal = options?.signal;
		if (signal?.aborted) return noop;
		this.#listeners.add(callback);
		if (!signal) return () => this.#listeners.delete(callback);
		const onAbort = () => this.#listeners.delete(callback);
		signal.addEventListener("abort", onAbort, { once: true });
		return () => {
			signal.removeEventListener("abort", onAbort);
			this.#listeners.delete(callback);
		};
	}
	flush() {
		if (!this.#pending) return;
		this.#pending = false;
		for (const fn of this.#listeners) fn();
	}
	#markPending() {
		this.#pending = true;
		pendingContainers.add(this);
		scheduleFlush();
	}
};
function createState(initial) {
	return new StateContainer(initial);
}

//#endregion
//#region ../store/dist/default/core/store.js
const STORE_SYMBOL = Symbol.for("@videojs/store");
const hasOwnProp = Object.prototype.hasOwnProperty;
function createStore() {
	return ((slice, options = {}) => {
		let target = null;
		let destroyed = false;
		const setupAbort = new AbortController();
		const signals = new AbortControllerRegistry();
		let sourceState;
		let state;
		function validate() {
			if (destroyed) throwDestroyedError();
			if (!target) throwNoTargetError();
		}
		const initialSourceState = freezeCopy(slice.state({
			target: () => {
				validate();
				return target;
			},
			signals,
			get: () => sourceState,
			set: (partial) => setSource(partial)
		}));
		sourceState = initialSourceState;
		const initialDerivedState = derive(sourceState);
		state = createState(publish(sourceState, initialDerivedState));
		const store = {
			[STORE_SYMBOL]: true,
			get $state() {
				return state;
			},
			get target() {
				return target;
			},
			get destroyed() {
				return destroyed;
			},
			get state() {
				return state.current;
			},
			attach,
			destroy,
			subscribe
		};
		for (const key of Object.keys(state.current)) Object.defineProperty(store, key, {
			get: () => state.current[key],
			enumerable: true
		});
		for (const key of Object.getOwnPropertySymbols(sourceState)) {
			if (typeof sourceState[key] !== "function") continue;
			Object.defineProperty(store, key, { get: () => sourceState[key] });
		}
		try {
			options.onSetup?.({
				store,
				signal: setupAbort.signal
			});
		} catch (error) {
			reportError(error);
		}
		return store;
		function derive(source) {
			const result = {};
			const definitions = slice.derived;
			if (!definitions) return result;
			const ctx = { get: () => source };
			for (const key of Object.keys(definitions)) result[key] = definitions[key](ctx);
			return result;
		}
		function publish(source, derived) {
			const result = {};
			for (const key of Object.keys(source)) result[key] = source[key];
			return Object.assign(result, derived);
		}
		function setSource(partial) {
			const patched = patchSource(sourceState, partial);
			if (!patched) return;
			const nextDerived = derive(patched.next);
			sourceState = patched.next;
			state.replace(publish(sourceState, nextDerived));
		}
		function attach(newTarget) {
			if (destroyed) throwDestroyedError();
			signals.reset();
			target = newTarget;
			const attachContext = {
				target: newTarget,
				signal: signals.base,
				get: () => sourceState,
				set: (partial) => {
					try {
						setSource(partial);
					} catch (error) {
						reportError(error);
					}
				},
				reportError,
				store: {
					get state() {
						return state.current;
					},
					subscribe
				}
			};
			try {
				slice.attach?.(attachContext);
			} catch (error) {
				reportError(error);
			}
			try {
				options.onAttach?.({
					store,
					target: newTarget,
					signal: signals.base
				});
			} catch (error) {
				reportError(error);
			}
			return detach;
		}
		function detach() {
			if (isNull(target)) return;
			signals.reset();
			target = null;
			const resetState = { ...initialSourceState };
			for (const key of slice.preserve ?? []) resetState[key] = sourceState[key];
			setSource(resetState);
		}
		function destroy() {
			if (destroyed) return;
			destroyed = true;
			detach();
			setupAbort.abort();
		}
		function subscribe(callback, options) {
			return state.subscribe(callback, options);
		}
		function reportError(error) {
			if (options.onError) options.onError({
				store,
				error
			});
			else console.error("[vjs-store]", error);
		}
	});
}
function freezeCopy(value) {
	return Object.freeze({ ...value });
}
function patchSource(current, partial) {
	const next = { ...current };
	let changed = false;
	for (const key of Reflect.ownKeys(partial)) {
		if (!hasOwnProp.call(partial, key)) continue;
		const value = partial[key];
		if (Object.is(current[key], value)) continue;
		next[key] = value;
		changed = true;
	}
	return changed ? { next: Object.freeze(next) } : null;
}
function isStore(value) {
	return isObject(value) && STORE_SYMBOL in value;
}

//#endregion
//#region ../core/dist/default/dom/feature.js
const definePlayerSlice = defineSlice();
function definePlayerFeature(definition, defaultConfig) {
	if (arguments.length === 1) {
		const feature = definition;
		const preserved = Object.values(feature.config ?? {}).map((entry) => entry.state);
		return {
			...feature,
			...preserved.length > 0 ? { preserve: preserved } : {}
		};
	}
	const { name, state, attach } = definition;
	const forConfig = (featureConfig) => definePlayerSlice({
		...isUndefined(name) ? {} : { name },
		state: (ctx) => state(ctx, featureConfig),
		...attach ? { attach: (ctx) => attach(ctx, featureConfig) } : {}
	});
	const defaultFeature = forConfig(defaultConfig);
	const feature = ((featureConfig) => isUndefined(featureConfig) ? defaultFeature : forConfig(featureConfig));
	feature.state = defaultFeature.state;
	if (defaultFeature.attach) feature.attach = defaultFeature.attach;
	if (!isUndefined(name)) Object.defineProperty(feature, "name", { value: name });
	return feature;
}
/** Merge the configuration declarations from the selected player features. */
function combinePlayerFeatureConfigs(features) {
	const definitions = features.map((feature) => feature.config ?? {});
	return Object.assign({}, ...definitions);
}
/** Forward one configuration input through its feature-owned private action. */
function setPlayerConfigValue(store, entry, value) {
	const action = store[entry.action];
	if (typeof action !== "function") throw new TypeError(`Missing config action "${String(entry.action)}"`);
	action(value);
}

//#endregion
//#region ../utils/dist/string/escape-html.js
function escapeHtml(str) {
	return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/`/g, "&#96;");
}

//#endregion
//#region ../utils/dist/dom/attributes.js
/** Capture authored values for the selected attributes. */
function snapshotAttributes(element, names) {
	return [...names].map((name) => ({
		name,
		value: element.getAttribute(name)
	}));
}
/** Restore a snapshot created by `snapshotAttributes`. */
function restoreAttributes(element, snapshot) {
	for (const { name, value } of snapshot) if (value === null) element.removeAttribute(name);
	else element.setAttribute(name, value);
}

//#endregion
//#region ../utils/dist/dom/children.js
function getElementChildren(parent, predicate) {
	const children = [];
	for (let index = 0; index < parent.children.length; index++) {
		const child = parent.children.item(index);
		if (child && predicate(child, index)) children.push(child);
	}
	return children;
}
function findElementChild(parent, predicate) {
	for (let index = 0; index < parent.children.length; index++) {
		const child = parent.children.item(index);
		if (child && predicate(child, index)) return child;
	}
	return null;
}
/** Follow a single-child relationship from the root until it ends or cycles. */
function followElementPath(root, getNext) {
	const path = [];
	const visited = /* @__PURE__ */ new Set();
	let current = root;
	while (current && !visited.has(current)) {
		path.push(current);
		visited.add(current);
		current = getNext(current);
	}
	return path;
}

//#endregion
//#region ../utils/dist/dom/direction.js
/** Check whether an element's text direction is right-to-left. */
function isRTL(element) {
	const dir = element.closest("[dir]")?.getAttribute("dir");
	if (dir) return dir.toLowerCase() === "rtl";
	return getComputedStyle(element).direction === "rtl";
}

//#endregion
//#region ../utils/dist/dom/event.js
/** Resolve the deepest event target, preferring composedPath for shadow DOM. */
function resolveEventTarget(event) {
	const path = event.composedPath();
	return path.length > 0 ? path[0] : event.target;
}
function onEvent(target, type, options) {
	return new Promise((resolve, reject) => {
		const handleAbort = () => {
			reject(options?.signal?.reason ?? "Aborted");
		};
		if (options?.signal?.aborted) {
			handleAbort();
			return;
		}
		options?.signal?.addEventListener("abort", handleAbort, { once: true });
		target.addEventListener(type, (event) => {
			options?.signal?.removeEventListener("abort", handleAbort);
			resolve(event);
		}, {
			...options,
			once: true
		});
	});
}

//#endregion
//#region ../utils/dist/dom/focus.js
function getDeepActiveElement(root = document) {
	let active = root.activeElement;
	while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
	return active;
}

//#endregion
//#region ../utils/dist/dom/supports.js
function supportsAnchorPositioning() {
	return typeof CSS !== "undefined" && CSS.supports("anchor-name: --a");
}

//#endregion
//#region ../utils/dist/dom/interactive.js
const INTERACTIVE_SELECTOR = [
	"button",
	"input",
	"select",
	"textarea",
	"a[href]",
	"[role=\"button\"]",
	"[role=\"menu\"]",
	"[role=\"menuitem\"]",
	"[role=\"menuitemcheckbox\"]",
	"[role=\"menuitemradio\"]",
	"[role=\"slider\"]",
	"[data-interactive]"
].join(",");
const EDITABLE_SELECTOR = [
	"textarea",
	"select",
	"input:not([type])",
	...[
		"text",
		"search",
		"url",
		"tel",
		"email",
		"password",
		"number"
	].map((type) => `input[type="${type}"]`),
	"[contenteditable]:not([contenteditable=\"false\"])"
].join(",");
function isEditableElement(el) {
	return el.matches(EDITABLE_SELECTOR);
}
/** Whether the keyboard event target is an editable element (input, textarea, etc). */
function isEditableTarget(event) {
	const target = resolveEventTarget(event);
	return target instanceof Element && isEditableElement(target);
}
/** Whether the event originated from an interactive control (button, slider, etc). */
function isInteractiveTarget(event) {
	const target = resolveEventTarget(event);
	if (!(target instanceof Element)) return false;
	return target.closest(INTERACTIVE_SELECTOR) !== null;
}
const ACTIVATION_KEYS = /* @__PURE__ */ new Set([" ", "Enter"]);
/**
* Selector for elements that use Space/Enter as a native activation key.
* Narrower than `INTERACTIVE_SELECTOR` — excludes editable elements like
* `input`, `textarea`, `select` where Space/Enter is text input, not activation.
*/
const ACTIVATABLE_SELECTOR = "button,a[href],[role=\"slider\"],[role=\"button\"]";
/** Whether the event is an activation key on an activatable element (button, link, slider). */
function isInteractiveActivation(event) {
	if (!ACTIVATION_KEYS.has(event.key)) return false;
	const target = resolveEventTarget(event);
	return target instanceof Element && target.matches(ACTIVATABLE_SELECTOR);
}

//#endregion
//#region ../utils/dist/string/casing.js
function kebabCase(str) {
	return str.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

//#endregion
//#region ../utils/dist/dom/style.js
function normalizeStyleProperty(property) {
	return property.startsWith("--") ? property : kebabCase(property);
}
function getAnchorNames(element) {
	const value = element.style.getPropertyValue("anchor-name").trim();
	if (!value || value === "none") return [];
	return value.split(",").map((name) => name.trim()).filter(Boolean);
}
function applyStyles(element, styles) {
	for (const [prop, value] of Object.entries(styles)) if (typeof value === "string") element.style.setProperty(normalizeStyleProperty(prop), value);
}
/** Capture authored inline values and priorities for the selected properties. */
function snapshotInlineStyles(element, properties) {
	return [...properties].map((property) => {
		const normalizedProperty = normalizeStyleProperty(property);
		return {
			property: normalizedProperty,
			value: element.style.getPropertyValue(normalizedProperty),
			priority: element.style.getPropertyPriority(normalizedProperty)
		};
	});
}
/** Restore a snapshot created by `snapshotInlineStyles`. */
function restoreInlineStyles(element, snapshot) {
	for (const { property, value, priority } of snapshot) if (value) element.style.setProperty(property, value, priority);
	else element.style.removeProperty(property);
}
/** Apply inline styles for a synchronous callback and restore authored styles afterward. */
function withInlineStyles(element, styles, callback) {
	const snapshot = snapshotInlineStyles(element, Object.keys(styles));
	try {
		applyStyles(element, styles);
		return callback();
	} finally {
		restoreInlineStyles(element, snapshot);
	}
}
/** Read and resolve a CSS property as a pixel length. */
function readCSSLength(element, property, { source = "inline-or-computed" } = {}) {
	const normalizedProperty = normalizeStyleProperty(property);
	let value = source !== "computed" && element instanceof HTMLElement ? element.style.getPropertyValue(normalizedProperty) : "";
	if (!value && source !== "inline") value = getComputedStyle(element).getPropertyValue(normalizedProperty);
	return value.trim() ? resolveCSSLength(element, value) : null;
}
function resolveCSSLength(el, value) {
	const trimmed = value.trim();
	if (!trimmed) return 0;
	const parsed = Number.parseFloat(trimmed);
	if (!Number.isNaN(parsed) && (/^-?\d*\.?\d+$/.test(trimmed) || trimmed.endsWith("px"))) return parsed;
	const doc = el.ownerDocument;
	const root = doc?.documentElement;
	if (!Number.isNaN(parsed) && trimmed.endsWith("rem")) return parsed * (root ? Number.parseFloat(getComputedStyle(root).fontSize) || 16 : 16);
	if (!Number.isNaN(parsed) && trimmed.endsWith("em")) return parsed * (el instanceof HTMLElement ? Number.parseFloat(getComputedStyle(el).fontSize) || 16 : 16);
	if (!doc) return Number.isNaN(parsed) ? 0 : parsed;
	const measurementEl = doc.createElement("div");
	measurementEl.style.position = "absolute";
	measurementEl.style.visibility = "hidden";
	measurementEl.style.pointerEvents = "none";
	measurementEl.style.inlineSize = trimmed;
	if (!measurementEl.style.inlineSize) return 0;
	measurementEl.style.blockSize = "0";
	measurementEl.style.padding = "0";
	measurementEl.style.border = "0";
	measurementEl.style.inset = "0";
	const computed = getComputedStyle(el);
	measurementEl.style.fontSize = computed.fontSize;
	for (let i = 0; i < computed.length; i++) {
		const name = computed.item(i);
		if (name.startsWith("--")) measurementEl.style.setProperty(name, computed.getPropertyValue(name));
	}
	const parent = doc.body ?? doc.documentElement;
	if (!parent) return Number.isNaN(parsed) ? 0 : parsed;
	parent.appendChild(measurementEl);
	if (getComputedStyle(measurementEl).inlineSize === "auto") {
		measurementEl.remove();
		return 0;
	}
	const pixels = measurementEl.getBoundingClientRect().width;
	measurementEl.remove();
	if (Number.isFinite(pixels)) return pixels;
	return Number.isNaN(parsed) ? 0 : parsed;
}

//#endregion
//#region ../utils/dist/dom/layout.js
/** Read an element's current rendered size. */
function getElementSize(element, { box = "bounding", overflow = "none" } = {}) {
	const rect = element.getBoundingClientRect();
	let width = box === "layout" ? element.offsetWidth || rect.width : rect.width;
	let height = box === "layout" ? element.offsetHeight || rect.height : rect.height;
	if (overflow === "width" || overflow === "both") width = Math.max(width, element.scrollWidth);
	if (overflow === "height" || overflow === "both") height = Math.max(height, element.scrollHeight);
	return {
		width,
		height
	};
}
/** Measure an element with optional temporary inline style overrides. */
function measureElement(element, options = {}) {
	const { styles, ...sizeOptions } = options;
	const measure = () => getElementSize(element, sizeOptions);
	return styles ? withInlineStyles(element, styles, measure) : measure();
}
/** Read logical padding edges in pixels. */
function getElementPadding(element) {
	const style = getComputedStyle(element);
	return {
		inlineStart: Number.parseFloat(style.paddingInlineStart) || 0,
		inlineEnd: Number.parseFloat(style.paddingInlineEnd) || 0,
		blockStart: Number.parseFloat(style.paddingBlockStart) || 0,
		blockEnd: Number.parseFloat(style.paddingBlockEnd) || 0
	};
}
function getInlineExtent(edges) {
	return edges.inlineStart + edges.inlineEnd;
}
function getBlockExtent(edges) {
	return edges.blockStart + edges.blockEnd;
}
function defaultResolveChildrenSize(measurements) {
	if (measurements.length === 0) return {
		width: 0,
		height: 0
	};
	const width = Math.max(...measurements.map(({ offsetLeft, size }) => offsetLeft + size.width));
	const firstTop = measurements[0].offsetTop;
	return {
		width,
		height: measurements.some(({ offsetTop }) => offsetTop !== firstTop) ? Math.max(...measurements.map(({ offsetTop, size }) => offsetTop + size.height)) : measurements.reduce((total, { size }) => total + size.height, 0)
	};
}
/** Measure the layout occupied by a collection of child elements. */
function measureElementChildren(container, { children, includePadding = false, maxWidth = null, measure = (element, width) => measureElement(element, width === void 0 ? void 0 : { styles: { width: `${width}px` } }), resolveSize = defaultResolveChildrenSize } = {}) {
	const elements = [...children ?? Array.from(container.children).filter((child) => child instanceof HTMLElement)].filter((element) => !element.hidden);
	const padding = includePadding ? getElementPadding(container) : {
		inlineStart: 0,
		inlineEnd: 0,
		blockStart: 0,
		blockEnd: 0
	};
	const inlinePadding = getInlineExtent(padding);
	const blockPadding = getBlockExtent(padding);
	if (elements.length === 0) return {
		width: inlinePadding,
		height: blockPadding
	};
	const collect = (width) => elements.map((element) => ({
		element,
		size: measure(element, width),
		offsetLeft: element.offsetLeft,
		offsetTop: element.offsetTop
	}));
	let measurements = collect();
	const naturalWidth = resolveSize(measurements).width + inlinePadding;
	const width = maxWidth === null ? naturalWidth : Math.min(naturalWidth, Math.max(0, maxWidth));
	if (width < naturalWidth) measurements = collect(Math.max(0, width - inlinePadding));
	return {
		width,
		height: resolveSize(measurements).height + blockPadding
	};
}

//#endregion
//#region ../utils/dist/dom/listen.js
function listen(target, type, listener, options) {
	target.addEventListener(type, listener, options);
	return () => target.removeEventListener(type, listener, options);
}

//#endregion
//#region ../utils/dist/dom/locale/effective-locale.js
/** Resolves locale: explicit non-empty value → ambient `lang` → {@link fallback}. */
function effectiveLocale(explicitLocale, ambientLang, fallback = "en") {
	if (!isUndefined(explicitLocale) && explicitLocale.trim() !== "") return explicitLocale;
	if (!isUndefined(ambientLang) && ambientLang.trim() !== "") return ambientLang;
	return fallback;
}

//#endregion
//#region ../utils/dist/dom/walk-ancestors.js
function walkAncestors(start, callback) {
	if (!start || typeof document === "undefined") return;
	let node = start;
	while (node) {
		const value = callback(node);
		if (!isUndefined(value)) return value;
		node = node.parentElement;
	}
}

//#endregion
//#region ../utils/dist/dom/locale/find-nearest-lang.js
function getElementLang(node) {
	const fromAttribute = node.getAttribute("lang")?.trim();
	if (fromAttribute) return fromAttribute;
	if ("lang" in node && typeof node.lang === "string") {
		const fromProperty = node.lang.trim();
		if (fromProperty) return fromProperty;
	}
}
/** First non-empty `lang` on `start` or an ancestor (HTML language inheritance). */
function findNearestLang(start) {
	return walkAncestors(start, getElementLang);
}

//#endregion
//#region ../utils/dist/dom/locale/merge-locale-overlays.js
/**
* Loads overlay layers for each resolved locale key, least-specific first, then merges
* most-specific-last (same semantics as the core i18n registry).
*/
async function mergeLocaleOverlays(locale, load, findKeys) {
	const chain = findKeys(locale);
	const layers = await Promise.all(chain.map((tag) => load(tag)));
	const loadedTags = [];
	const merged = {};
	for (let i = 0; i < chain.length; i++) {
		const layer = layers[i];
		if (layer && Object.keys(layer).length > 0) loadedTags.push(chain[i]);
	}
	for (let i = chain.length - 1; i >= 0; i--) {
		const layer = layers[i];
		if (layer) Object.assign(merged, layer);
	}
	return {
		merged,
		loadedTags
	};
}

//#endregion
//#region ../utils/dist/dom/locale/resolve-lang-attr.js
/**
* Normalizes a raw `lang` string (e.g. from {@link findNearestLang}): empty or whitespace-only →
* `undefined`, otherwise the trimmed value.
*/
function resolveLangAttr(raw) {
	if (isUndefined(raw) || raw.trim() === "") return;
	return raw.trim();
}

//#endregion
//#region ../utils/dist/dom/locale/subscribe-ambient-lang.js
const subscribers = /* @__PURE__ */ new Set();
let observer;
let queued = false;
const flush = () => {
	queued = false;
	for (const cb of subscribers) cb();
};
const schedule = () => {
	if (!queued) {
		queued = true;
		queueMicrotask(flush);
	}
};
function start() {
	if (observer || typeof document === "undefined") return;
	observer = new MutationObserver(schedule);
	observer.observe(document.documentElement, {
		subtree: true,
		attributes: true,
		attributeFilter: ["lang"],
		childList: true
	});
}
function stop() {
	if (subscribers.size || !observer) return;
	observer.disconnect();
	observer = void 0;
	queued = false;
}
/**
* Subscribes to DOM updates that can change inherited `lang`: any `lang` attribute edit,
* or subtree structural changes under `<html>` (which can move nodes between labeled ancestors).
*/
function subscribeAmbientLang(onStoreChange) {
	if (typeof document === "undefined") return () => {};
	subscribers.add(onStoreChange);
	start();
	return () => {
		subscribers.delete(onStoreChange);
		stop();
	};
}

//#endregion
//#region ../utils/dist/dom/observe-elements.js
/** Observe one or more elements for size changes and return a cleanup function. */
function observeResize(elements, callback) {
	if (typeof ResizeObserver === "undefined") return noop;
	const observer = new ResizeObserver(callback);
	const targets = Symbol.iterator in Object(elements) ? elements : [elements];
	for (const element of targets) observer.observe(element);
	return () => observer.disconnect();
}
/**
* Observe a dynamically resolved element set. When the optional root mutates,
* the set is resolved again before `onChange` is called.
*/
function observeElements({ getElements, onChange, root, mutations }) {
	let stopObservingResize = noop;
	const observeCurrentElements = () => {
		stopObservingResize();
		stopObservingResize = observeResize(getElements(), onChange);
	};
	observeCurrentElements();
	let mutationObserver = null;
	if (root && mutations !== false && typeof MutationObserver !== "undefined") {
		mutationObserver = new MutationObserver(() => {
			observeCurrentElements();
			onChange();
		});
		mutationObserver.observe(root, mutations ?? { childList: true });
	}
	return () => {
		mutationObserver?.disconnect();
		stopObservingResize();
	};
}

//#endregion
//#region ../utils/dist/dom/platform.js
function isMacOS() {
	return typeof navigator !== "undefined" && /mac/i.test(navigator.userAgent);
}

//#endregion
//#region ../utils/dist/dom/popover.js
const ZERO_OFFSETS$1 = {
	sideOffset: 0,
	boundaryOffset: 0
};
const OPPOSITE_SIDE$1 = {
	top: "bottom",
	bottom: "top",
	left: "right",
	right: "left"
};
function getSideAvailable(triggerRect, boundaryRect, side, offsets) {
	const boundaryOffset = offsets.boundaryOffset ?? 0;
	switch (side) {
		case "top": return triggerRect.top - boundaryRect.top - boundaryOffset - offsets.sideOffset;
		case "bottom": return boundaryRect.bottom - triggerRect.bottom - boundaryOffset - offsets.sideOffset;
		case "left": return triggerRect.left - boundaryRect.left - boundaryOffset - offsets.sideOffset;
		case "right": return boundaryRect.right - triggerRect.right - boundaryOffset - offsets.sideOffset;
	}
}
/** Resolve the preferred side against a positioning boundary. */
function getPositionedSide(triggerRect, positionedRect, boundaryRect, opts, offsets = ZERO_OFFSETS$1) {
	const preferred = opts.side;
	const opposite = OPPOSITE_SIDE$1[preferred];
	const size = preferred === "top" || preferred === "bottom" ? positionedRect.height : positionedRect.width;
	const preferredSpace = getSideAvailable(triggerRect, boundaryRect, preferred, offsets);
	if (preferredSpace >= size) return preferred;
	return getSideAvailable(triggerRect, boundaryRect, opposite, offsets) > preferredSpace ? opposite : preferred;
}
function tryShowPopover(el) {
	try {
		el?.showPopover?.();
	} catch {}
}
function tryHidePopover(el) {
	try {
		el?.hidePopover?.();
	} catch {}
}

//#endregion
//#region ../utils/dist/dom/predicates.js
function isDocument(value) {
	return value instanceof Node && value.nodeType === 9;
}
function isShadowRoot(value) {
	return value instanceof Node && value.nodeType === 11 && "host" in value;
}

//#endregion
//#region ../utils/dist/dom/raf-throttle.js
/** Throttle a function to fire at most once per animation frame. */
function rafThrottle(fn) {
	let rafId = null;
	let latestArgs;
	const throttled = (...args) => {
		latestArgs = args;
		if (rafId !== null) return;
		rafId = requestAnimationFrame(() => {
			rafId = null;
			fn(...latestArgs);
		});
	};
	throttled.cancel = () => {
		if (rafId !== null) {
			cancelAnimationFrame(rafId);
			rafId = null;
		}
	};
	return throttled;
}

//#endregion
//#region ../utils/dist/dom/shadow-styles.js
/** Inject a `<style>` tag into `document.head` once (idempotent by `id`). */
function ensureGlobalStyle(id, css) {
	const doc = globalThis.document;
	if (!doc || doc.getElementById(id)) return;
	const style = doc.createElement("style");
	style.id = id;
	style.textContent = css;
	doc.head.appendChild(style);
}
function isConstructableStyleSheet(value) {
	return typeof globalThis.CSSStyleSheet !== "undefined" && value instanceof globalThis.CSSStyleSheet;
}
function getStyleText(style) {
	if (typeof style === "string") return style;
	return Array.from(style.cssRules).map((rule) => rule.cssText).join("\n");
}
/** Create a constructable stylesheet when available, otherwise return raw CSS. */
function createShadowStyle(css) {
	if (typeof globalThis.CSSStyleSheet === "undefined") return css;
	const sheet = new globalThis.CSSStyleSheet();
	sheet.replaceSync(css);
	return sheet;
}
/** Apply styles to a shadow root using `adoptedStyleSheets` when available, falling back to `<style>` injection. */
function applyShadowStyles(shadowRoot, styles) {
	if (styles.every(isConstructableStyleSheet) && "adoptedStyleSheets" in shadowRoot) {
		shadowRoot.adoptedStyleSheets = styles;
		return;
	}
	const doc = shadowRoot.ownerDocument;
	for (const styleText of styles.map(getStyleText)) {
		const style = doc.createElement("style");
		style.textContent = styleText;
		shadowRoot.appendChild(style);
	}
}

//#endregion
//#region ../utils/dist/dom/template.js
/** Create an `HTMLTemplateElement` from an HTML string, or `null` when `document` is unavailable (SSR). */
function createTemplate(html) {
	const doc = globalThis.document;
	if (!doc) return null;
	const template = doc.createElement("template");
	template.innerHTML = html;
	return template;
}
/** Return the first direct-child template in a container. */
function getTemplateElement(container) {
	for (const child of container.children) if (child.localName === "template" && "content" in child) return child;
	return null;
}
/** Return a template's only element root, or `null` when it does not contain exactly one. */
function getTemplateRoot(template) {
	const root = template.content.firstElementChild;
	return root && !root.nextElementSibling ? root : null;
}
/** Deep-clone a resolved template root into the target document. */
function cloneTemplateRoot(root, targetDocument = root.ownerDocument) {
	return targetDocument.importNode(root, true);
}
/** Deep-clone a template's content into a container. */
function renderTemplate(container, template) {
	container.appendChild(container.ownerDocument.importNode(template.content, true));
}

//#endregion
//#region ../utils/dist/dom/text-track.js
/** Whether a text track is a captions or subtitles track. */
function isCaptionOrSubtitleTrack(track) {
	return track.kind === "captions" || track.kind === "subtitles";
}
/** Find the `<track>` element that owns the given `TextTrack`. */
function findTrackElement(media, track) {
	if (!(media instanceof HTMLElement)) return null;
	for (const el of media.querySelectorAll("track")) if (el.track === track) return el;
	return null;
}

//#endregion
//#region ../utils/dist/dom/time-ranges.js
/** Converts a TimeRanges object to an array of [start, end] tuples. */
function serializeTimeRanges(ranges) {
	const result = [];
	for (let i = 0; i < ranges.length; i++) result.push([ranges.start(i), ranges.end(i)]);
	return result;
}

//#endregion
//#region ../utils/dist/dom/tree.js
function containsComposed(root, element) {
	let current = element;
	while (current) {
		if (current === root || root.contains(current)) return true;
		const nodeRoot = current.getRootNode();
		current = isShadowRoot(nodeRoot) ? nodeRoot.host : current.parentNode;
	}
	return false;
}

//#endregion
//#region ../utils/dist/dom/webkit.js
/** Whether WebKit's AirPlay APIs are present in this realm (Safari macOS/iOS). */
function supportsWebKitAirPlay() {
	return "WebKitPlaybackTargetAvailabilityEvent" in globalThis;
}
/** Whether `media` exposes WebKit's AirPlay APIs. */
function isWebKitAirPlayCapable(media) {
	return supportsWebKitAirPlay() && "webkitCurrentPlaybackTargetIsWireless" in media;
}

//#endregion
//#region ../media/dist/default/core/constants.js
/** A frozen, empty `TimeRanges`-like value for hosts with no ranges. */
const EMPTY_TIME_RANGES = Object.freeze({
	length: 0,
	start: () => 0,
	end: () => 0
});
/** A frozen, empty `TextTrackList`-like value for hosts with no text tracks. */
const EMPTY_TEXT_TRACKS = Object.assign(new EventTarget(), {
	length: 0,
	*[Symbol.iterator]() {},
	getTrackById: () => null
});
const EMPTY_REMOTE = new EventTarget();

//#endregion
//#region ../media/dist/default/core/media-error.js
var MediaError = class MediaError extends Error {
	static MEDIA_ERR_ABORTED = 1;
	static MEDIA_ERR_NETWORK = 2;
	static MEDIA_ERR_DECODE = 3;
	static MEDIA_ERR_SRC_NOT_SUPPORTED = 4;
	static MEDIA_ERR_ENCRYPTED = 5;
	static MEDIA_ERR_CUSTOM = 100;
	static defaultMessages = {
		1: "You stopped media playback before it finished.",
		2: "This media could not be loaded due to a network or server issue.",
		3: "This media could not be played. It may be corrupted, or your browser may not support its format.",
		4: "This media could not be loaded. It may be unavailable, or your browser may not support its format.",
		5: "This media could not be played because it could not be decrypted."
	};
	name;
	code;
	context;
	fatal;
	data;
	constructor(message, code = MediaError.MEDIA_ERR_CUSTOM, fatal, context) {
		super(message);
		this.name = "MediaError";
		this.code = code;
		this.context = context;
		this.fatal = fatal ?? (code >= MediaError.MEDIA_ERR_NETWORK && code <= MediaError.MEDIA_ERR_ENCRYPTED);
		if (!this.message) this.message = MediaError.defaultMessages[this.code] ?? "";
	}
};

//#endregion
//#region ../media/dist/default/core/predicate.js
function hasMetadata(media) {
	return media.readyState >= 1;
}
function isMediaPauseCapable(value) {
	if (!isObject(value)) return false;
	const media = value;
	return !isUndefined(media.paused) && !isUndefined(media.ended) && isFunction(media.pause);
}
function isMediaSeekCapable(value) {
	if (!isObject(value)) return false;
	const media = value;
	return !isUndefined(media.currentTime) && !isUndefined(media.duration) && !isUndefined(media.seeking);
}
function isMediaSourceCapable(value) {
	if (!isObject(value)) return false;
	const media = value;
	return !isUndefined(media.src) && !isUndefined(media.currentSrc) && !isUndefined(media.readyState) && isFunction(media.load);
}
function isMediaVolumeCapable(value) {
	if (!isObject(value)) return false;
	const media = value;
	return !isUndefined(media.volume) && !isUndefined(media.muted);
}
/**
* Whether the media reports a mute at all, which is a narrower question than
* `isMediaVolumeCapable`: an embed can take a mute command while offering no way
* to set a level.
*/
function isMediaMutedCapable(value) {
	if (!isObject(value)) return false;
	return !isUndefined(value.muted);
}
function isMediaPlaybackRateCapable(value) {
	if (!isObject(value)) return false;
	return !isUndefined(value.playbackRate);
}
/**
* Only `requestPictureInPicture` is required. A native video element carries it
* but leaves exiting to `document`, so demanding the pair would rule out the one
* media that most certainly can.
*/
function isMediaPictureInPictureCapable(value) {
	if (!isObject(value)) return false;
	return isFunction(value.requestPictureInPicture);
}
function isMediaBufferCapable(value) {
	if (!isObject(value)) return false;
	const media = value;
	return !isUndefined(media.buffered) && media.buffered !== EMPTY_TIME_RANGES && !isUndefined(media.seekable) && media.seekable !== EMPTY_TIME_RANGES;
}
function isMediaErrorCapable(value) {
	if (!isObject(value)) return false;
	return !isUndefined(value.error);
}
function isMediaTextTrackCapable(value) {
	if (!isObject(value)) return false;
	const media = value;
	return !isUndefined(media.textTracks) && media.textTracks !== EMPTY_TEXT_TRACKS;
}
function isMediaVideoRenditionCapable(value) {
	if (!isObject(value)) return false;
	return !isUndefined(value.videoRenditions);
}
function isMediaAudioTrackCapable(value) {
	if (!isObject(value)) return false;
	return !isUndefined(value.audioTracks);
}
function isMediaVideoDimensionsCapable(value) {
	if (!isObject(value)) return false;
	const media = value;
	return !isUndefined(media.videoWidth) && !isUndefined(media.videoHeight);
}
function isMediaRemotePlaybackCapable(value) {
	if (!isObject(value)) return false;
	const media = value;
	return isObject(media.remote) && media.remote !== EMPTY_REMOTE;
}
function isMediaStreamTypeCapable(value) {
	if (!isObject(value)) return false;
	return !isUndefined(value.streamType);
}
function isMediaContentDataCapable(value) {
	if (!isObject(value)) return false;
	return !isUndefined(value.contentData);
}
function isMediaLiveCapable(value) {
	if (!isObject(value)) return false;
	const media = value;
	return !isUndefined(media.liveEdgeStart) && !isUndefined(media.targetLiveWindow);
}
function isQuerySelectorAllCapable(value) {
	return isObject(value) && "querySelectorAll" in value && isFunction(value.querySelectorAll);
}

//#endregion
//#region ../media/dist/default/core/types.js
/**
* Canonical values for {@link MediaStreamType}.
*
* - `ON_DEMAND` — a finite-duration asset (VOD). Scrubbing is generally
*   supported across the full timeline.
* - `LIVE` — a live or DVR stream. The seekable window may slide as new
*   segments are published, and `duration` is typically `Infinity`.
* - `UNKNOWN` — the stream type has not been determined yet (no source,
*   or metadata has not loaded).
*/
const MediaStreamTypes = {
	ON_DEMAND: "on-demand",
	LIVE: "live",
	UNKNOWN: "unknown"
};

//#endregion
//#region ../core/dist/default/dom/store/features/audio-track.js
function getTrackValue$1(track, index) {
	return track.id || String(index);
}
function toMediaTrack(track) {
	return {
		...track.id !== void 0 && { id: track.id },
		...track.kind !== void 0 && { kind: track.kind },
		label: track.label,
		language: track.language,
		enabled: track.enabled
	};
}
const audioTrackFeature = definePlayerFeature({
	name: "audioTrack",
	state: ({ target }) => ({
		audioTrackList: [],
		selectAudioTrack(value) {
			const { media } = target();
			if (!isMediaAudioTrackCapable(media)) return;
			const tracks = [...media.audioTracks];
			const track = tracks.find((candidate, index) => getTrackValue$1(candidate, index) === value);
			if (!track) return;
			for (const candidate of tracks) candidate.enabled = candidate === track;
		}
	}),
	attach({ target, signal, set }) {
		const { media } = target;
		let audioTracks = null;
		let cleanup = null;
		const getAudioTracks = () => isMediaAudioTrackCapable(media) ? media.audioTracks : null;
		const sync = (list = getAudioTracks()) => {
			set({ audioTrackList: list ? [...list].map(toMediaTrack) : [] });
		};
		const bind = () => {
			const nextAudioTracks = getAudioTracks();
			if (nextAudioTracks === audioTracks) {
				sync(nextAudioTracks);
				return;
			}
			cleanup?.abort();
			cleanup = new AbortController();
			audioTracks = nextAudioTracks;
			if (audioTracks) {
				listen(audioTracks, "addtrack", () => sync(audioTracks), { signal: cleanup.signal });
				listen(audioTracks, "removetrack", () => sync(audioTracks), { signal: cleanup.signal });
				listen(audioTracks, "change", () => sync(audioTracks), { signal: cleanup.signal });
			}
			sync(audioTracks);
		};
		bind();
		listen(media, "loadstart", bind, { signal });
		signal.addEventListener("abort", () => cleanup?.abort(), { once: true });
	}
});

//#endregion
//#region ../core/dist/default/dom/store/features/buffer.js
const bufferFeature = definePlayerFeature({
	name: "buffer",
	state: () => ({
		buffered: [],
		seekable: []
	}),
	attach({ target, signal, set }) {
		const { media } = target;
		if (!isMediaBufferCapable(media)) return;
		const sync = () => set({
			buffered: serializeTimeRanges(media.buffered),
			seekable: serializeTimeRanges(media.seekable)
		});
		sync();
		listen(media, "progress", sync, { signal });
		listen(media, "emptied", sync, { signal });
	}
});

//#endregion
//#region ../core/dist/default/dom/gesture/region.js
/**
* Determine which named region a pointer position falls into.
*
* Regions divide the container width equally based on how many are active:
* - `left` + `right` → halves (50% / 50%)
* - `left` + `center` + `right` → thirds (33% / 34% / 33%)
*
* Single region: `left` covers the left half, `right` the right half,
* and `center` covers the full surface. Partial two-region combos
* (e.g. `left` + `center`) use the same natural zones — positions outside
* all active zones return `null` so full-surface gestures can handle them.
*/
function resolveRegion(clientX, containerRect, activeRegions) {
	if (activeRegions.size === 0) return null;
	const relativeX = clientX - containerRect.left;
	const width = containerRect.width;
	if (width === 0) return null;
	const ratio = relativeX / width;
	if (activeRegions.size === 2 && activeRegions.has("left") && activeRegions.has("right")) return ratio < .5 ? "left" : "right";
	if (activeRegions.size === 3) {
		if (ratio < 1 / 3) return "left";
		if (ratio < 2 / 3) return "center";
		return "right";
	}
	if (activeRegions.has("left") && ratio < .5) return "left";
	if (activeRegions.has("right") && ratio >= .5) return "right";
	if (activeRegions.has("center")) {
		if (activeRegions.size === 1) return "center";
		if (ratio >= 1 / 3 && ratio < 2 / 3) return "center";
	}
	return null;
}

//#endregion
//#region ../core/dist/default/dom/gesture/coordinator.js
const TAP_THRESHOLD$1 = 250;
var GestureCoordinator = class {
	#target;
	#bindings = [];
	#recognizers = /* @__PURE__ */ new Set();
	#disconnect = null;
	#subscribers = /* @__PURE__ */ new Set();
	constructor(target) {
		this.#target = target;
	}
	get bindings() {
		return this.#bindings;
	}
	subscribe(callback) {
		this.#subscribers.add(callback);
		return () => this.#subscribers.delete(callback);
	}
	/**
	* Whether a registered binding claims this tap for the given action. A claimed tap
	* belongs to the gesture layer, so callers should leave it alone. Taps on interactive
	* targets (buttons, sliders) are never claimed — the same filtering the pointerup
	* listener applies. A disabled binding still claims: disabling a gesture opts out of
	* the action, it doesn't hand the tap back to a fallback handler.
	*/
	claimsTap(event, action) {
		if (isInteractiveTarget(event)) return false;
		return this.#bindings.some((b) => b.type === "tap" && b.action === action && (!b.pointer || b.pointer === event.pointerType));
	}
	add(binding) {
		const wrapped = {
			...binding,
			onActivate: (event) => {
				if (this.#subscribers.size > 0) {
					const activateEvent = {
						type: binding.type,
						source: "gesture",
						action: binding.action,
						value: binding.value,
						region: binding.region,
						pointer: binding.pointer,
						event
					};
					for (const cb of this.#subscribers) try {
						cb(activateEvent);
					} catch (error) {}
				}
				binding.onActivate(event);
			}
		};
		this.#bindings.push(wrapped);
		this.#recognizers.add(wrapped.recognizer);
		this.#connect();
		let removed = false;
		return () => {
			if (removed) return;
			removed = true;
			const idx = this.#bindings.indexOf(wrapped);
			if (idx !== -1) this.#bindings.splice(idx, 1);
			this.#maybeDisconnect();
		};
	}
	#connect() {
		if (this.#disconnect) return;
		this.#disconnect = new AbortController();
		const { signal } = this.#disconnect;
		let pointerDownTime = 0;
		listen(this.#target, "pointerdown", (event) => {
			if (event.button !== 0) return;
			pointerDownTime = Date.now();
		}, { signal });
		listen(this.#target, "pointerup", (event) => {
			if (event.button !== 0) return;
			if (Date.now() - pointerDownTime > TAP_THRESHOLD$1) return;
			if (isInteractiveTarget(event)) return;
			const pointerType = event.pointerType;
			const clientX = event.clientX;
			const target = this.#target;
			const bindings = this.#bindings;
			const matches = { resolve: (type) => matchBindings(bindings, type, pointerType, clientX, target) };
			for (const recognizer of this.#recognizers) recognizer.handleUp(matches, event);
		}, { signal });
	}
	#maybeDisconnect() {
		if (this.#bindings.length > 0) return;
		for (const recognizer of this.#recognizers) recognizer.reset();
		this.#recognizers.clear();
		this.#disconnect?.abort();
		this.#disconnect = null;
	}
};
const coordinators$1 = /* @__PURE__ */ new WeakMap();
/** Look up the gesture coordinator for a target element, if one exists. */
function findGestureCoordinator(target) {
	return coordinators$1.get(target);
}
function getGestureCoordinator(target) {
	let coordinator = coordinators$1.get(target);
	if (!coordinator) {
		coordinator = new GestureCoordinator(target);
		coordinators$1.set(target, coordinator);
	}
	return coordinator;
}
function matchBindings(bindings, type, pointerType, clientX, target) {
	const rect = target.getBoundingClientRect();
	const activeRegions = getActiveRegions(bindings, type, pointerType);
	const region = activeRegions.size > 0 ? resolveRegion(clientX, rect, activeRegions) : null;
	const matches = [];
	for (const binding of bindings) {
		if (binding.disabled) continue;
		if (binding.type !== type) continue;
		if (binding.pointer && binding.pointer !== pointerType) continue;
		if (binding.region) {
			if (binding.region !== region) continue;
		} else if (region !== null) continue;
		matches.push(binding);
	}
	return matches;
}
function getActiveRegions(bindings, type, pointerType) {
	const regions = /* @__PURE__ */ new Set();
	for (const binding of bindings) {
		if (binding.disabled) continue;
		if (binding.type !== type) continue;
		if (binding.pointer && binding.pointer !== pointerType) continue;
		if (binding.region) regions.add(binding.region);
	}
	return regions;
}

//#endregion
//#region ../core/dist/default/dom/presentation/remote-playback.js
function resolveRemote(media) {
	const target = media;
	if (isObject(target.remote) && "state" in target.remote && "prompt" in target.remote) return target.remote;
}
function isRemotePlaybackConnected(media) {
	return resolveRemote(media)?.state === "connected";
}
function isRemotePlaybackConnecting(media) {
	return resolveRemote(media)?.state === "connecting";
}
async function requestRemotePlayback(media) {
	const remote = resolveRemote(media);
	if (!remote) throw new DOMException("Remote playback not supported", "NotSupportedError");
	return remote.prompt();
}

//#endregion
//#region ../core/dist/default/dom/store/features/controls.js
const IDLE_DELAY = 2e3;
const TAP_THRESHOLD = 250;
const TOUCH_SETTLE_DELAY = 500;
const controlsActionsByRequest = /* @__PURE__ */ new WeakMap();
const controlsFeature = definePlayerFeature({
	name: "controls",
	state: ({ get, set }) => {
		const fallbackRequestControlsLock = () => {
			set({ controlsVisible: true });
			return () => {};
		};
		const fallbackToggleControls = () => {
			const next = !get().userActive;
			set({
				userActive: next,
				controlsVisible: next
			});
			return next;
		};
		const actions = createControlsActions(fallbackRequestControlsLock, fallbackToggleControls);
		controlsActionsByRequest.set(actions.requestControlsLock, actions);
		return {
			userActive: true,
			controlsVisible: true,
			requestControlsLock: actions.requestControlsLock,
			toggleControls: actions.toggleControls
		};
	},
	attach({ target, signal, get, set }) {
		const { media, container } = target;
		if (!isMediaPauseCapable(media) || isNull(container)) return;
		let idleTimer;
		let controlsLockCount = 0;
		const computeVisible = (userActive) => {
			return controlsLockCount > 0 || userActive || media.paused || isRemotePlaybackConnected(media) || isRemotePlaybackConnecting(media);
		};
		function clearIdle() {
			clearTimeout(idleTimer);
			idleTimer = void 0;
		}
		function scheduleIdle() {
			clearIdle();
			if (controlsLockCount > 0) return;
			idleTimer = setTimeout(setInactive, IDLE_DELAY);
		}
		function setActive() {
			if (!get().userActive) set({
				userActive: true,
				controlsVisible: true
			});
			scheduleIdle();
		}
		function setInactive() {
			clearIdle();
			set({
				userActive: false,
				controlsVisible: computeVisible(false)
			});
		}
		function requestControlsLock() {
			controlsLockCount++;
			clearIdle();
			if (!get().controlsVisible) set({ controlsVisible: true });
			let released = false;
			return () => {
				if (released || signal.aborted) return;
				released = true;
				controlsLockCount--;
				if (controlsLockCount === 0) setActive();
			};
		}
		function toggleControls() {
			if (get().controlsVisible) setInactive();
			else setActive();
			return get().controlsVisible;
		}
		const actions = controlsActionsByRequest.get(get().requestControlsLock);
		actions.setDelegates(requestControlsLock, toggleControls);
		let pointerDownTime = 0;
		let lastTouchAt = 0;
		const isRecentTouch = () => lastTouchAt > 0 && Date.now() - lastTouchAt < TOUCH_SETTLE_DELAY;
		function onPointerDown(event) {
			pointerDownTime = Date.now();
			if (event.pointerType === "touch") lastTouchAt = pointerDownTime;
		}
		function onPointerUp(event) {
			if (event.pointerType === "touch") lastTouchAt = Date.now();
			if (event.pointerType === "touch" && Date.now() - pointerDownTime < TAP_THRESHOLD) {
				if (findGestureCoordinator(container)?.claimsTap(event, "toggleControls")) return;
				const isMediaOrContainer = [media, container].includes(event.target);
				if (get().controlsVisible && isMediaOrContainer) setInactive();
				else setActive();
			} else setActive();
		}
		const onPlaybackChange = () => {
			const { userActive } = get();
			set({ controlsVisible: computeVisible(userActive) });
			if (!media.paused && userActive) scheduleIdle();
		};
		function onPointerMove(event) {
			if (event.pointerType === "touch") {
				if (get().userActive) scheduleIdle();
				return;
			}
			setActive();
		}
		listen(container, "pointermove", onPointerMove, { signal });
		listen(container, "pointerdown", onPointerDown, { signal });
		listen(container, "pointerup", onPointerUp, { signal });
		listen(container, "keyup", setActive, { signal });
		listen(container, "focusin", () => {
			if (isRecentTouch()) return;
			setActive();
		}, { signal });
		listen(container, "mouseleave", () => {
			if (isRecentTouch()) return;
			setInactive();
		}, { signal });
		listen(media, "play", onPlaybackChange, { signal });
		listen(media, "pause", onPlaybackChange, { signal });
		listen(media, "ended", onPlaybackChange, { signal });
		if (isMediaRemotePlaybackCapable(media)) {
			const onCastChange = () => {
				const { userActive } = get();
				set({ controlsVisible: computeVisible(userActive) });
			};
			listen(media.remote, "connect", onCastChange, { signal });
			listen(media.remote, "connecting", onCastChange, { signal });
			listen(media.remote, "disconnect", onCastChange, { signal });
		}
		signal.addEventListener("abort", () => {
			actions.reset();
			controlsLockCount = 0;
			clearIdle();
		}, { once: true });
		scheduleIdle();
	}
});
function createControlsActions(fallbackRequestControlsLock, fallbackToggleControls) {
	let requestControlsLockDelegate = fallbackRequestControlsLock;
	let toggleControlsDelegate = fallbackToggleControls;
	const locks = /* @__PURE__ */ new Set();
	const requestControlsLock = () => {
		const lock = { release: requestControlsLockDelegate() };
		let released = false;
		locks.add(lock);
		return () => {
			if (released) return;
			released = true;
			locks.delete(lock);
			lock.release();
		};
	};
	const toggleControls = () => toggleControlsDelegate();
	const actions = {
		requestControlsLock,
		toggleControls,
		setDelegates(nextRequestControlsLock, nextToggleControls) {
			if (nextRequestControlsLock !== requestControlsLockDelegate) {
				requestControlsLockDelegate = nextRequestControlsLock;
				for (const lock of locks) {
					lock.release();
					lock.release = nextRequestControlsLock();
				}
			}
			toggleControlsDelegate = nextToggleControls;
		},
		reset() {
			actions.setDelegates(fallbackRequestControlsLock, fallbackToggleControls);
		}
	};
	return actions;
}

//#endregion
//#region ../core/dist/default/dom/store/features/error.js
const errorFeature = definePlayerFeature({
	name: "error",
	state: ({ set }) => ({
		error: null,
		dismissError() {
			set({ error: null });
		}
	}),
	attach({ target, signal, set }) {
		const { media } = target;
		if (!isMediaErrorCapable(media)) return;
		const syncError = () => set({ error: media.error });
		listen(media, "error", syncError, { signal });
		listen(media, "emptied", () => set({ error: null }), { signal });
	}
});

//#endregion
//#region ../core/dist/default/dom/presentation/fullscreen.js
function isFullscreenEnabled() {
	const doc = document;
	if (doc.fullscreenEnabled || doc.webkitFullscreenEnabled) return true;
	return isFunction(document.createElement("video").webkitSetPresentationMode);
}
function getFullscreenElement() {
	const doc = document;
	return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}
function matchesFullscreen(element) {
	if (!(element instanceof Element)) return false;
	try {
		return element.matches(":fullscreen");
	} catch {
		return false;
	}
}
function isFullscreen(container, media) {
	if (media.webkitPresentationMode === "fullscreen") return true;
	const fullscreenElement = getFullscreenElement();
	if (fullscreenElement && (fullscreenElement === container || fullscreenElement === media)) return true;
	if (matchesFullscreen(container) || matchesFullscreen(media)) return true;
	return media.isFullscreen ?? false;
}
async function requestFullscreen(container, media) {
	const doc = document;
	if (container && (doc.fullscreenEnabled || doc.webkitFullscreenEnabled)) {
		const el = container;
		if (isFunction(el.requestFullscreen)) return el.requestFullscreen();
		if (isFunction(el.webkitRequestFullscreen)) return el.webkitRequestFullscreen();
	}
	const webkitVideo = media;
	if (isFunction(webkitVideo.webkitSetPresentationMode)) {
		webkitVideo.webkitSetPresentationMode("fullscreen");
		return;
	}
	const video = media;
	if (isFunction(video.requestFullscreen)) return video.requestFullscreen();
}
async function exitFullscreen(media) {
	const doc = document;
	const webkitVideo = media;
	if (webkitVideo.webkitPresentationMode === "fullscreen" && isFunction(webkitVideo.webkitSetPresentationMode)) {
		webkitVideo.webkitSetPresentationMode("inline");
		return;
	}
	if (isFunction(doc.exitFullscreen)) return doc.exitFullscreen();
	if (isFunction(doc.webkitExitFullscreen)) return doc.webkitExitFullscreen();
	const video = media;
	if (isFunction(video.exitFullscreen)) return video.exitFullscreen();
}

//#endregion
//#region ../core/dist/default/dom/presentation/pip.js
function isPictureInPictureEnabled() {
	if (document.pictureInPictureEnabled) {
		const isSafari = /.*Version\/.*Safari\/.*/.test(navigator.userAgent);
		const isPWA = typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches;
		return !isSafari || !isPWA;
	}
	return isFunction(document.createElement("video").webkitSetPresentationMode);
}
/**
* Whether this media can enter picture-in-picture at all, which is a separate
* question from whether the browser supports it. Mirrors the branches
* `requestPictureInPicture` takes below, so anything it would refuse to act on
* reports as incapable here — an iframe embed whose provider has no
* picture-in-picture can never enter it, however capable the browser is.
*/
function isPictureInPictureCapable(media) {
	if (isFunction(media.webkitSetPresentationMode)) return true;
	return isMediaPictureInPictureCapable(media);
}
function isPictureInPicture(media) {
	if (media.webkitPresentationMode === "picture-in-picture") return true;
	if (document.pictureInPictureElement === media) return true;
	return media.isPictureInPicture ?? false;
}
async function requestPictureInPicture(media) {
	const webkitVideo = media;
	if (isFunction(webkitVideo.webkitSetPresentationMode)) {
		webkitVideo.webkitSetPresentationMode("picture-in-picture");
		return;
	}
	const video = media;
	if (isFunction(video.requestPictureInPicture)) return video.requestPictureInPicture();
}
async function exitPictureInPicture(media) {
	const webkitVideo = media;
	if (webkitVideo.webkitPresentationMode === "picture-in-picture" && isFunction(webkitVideo.webkitSetPresentationMode)) {
		webkitVideo.webkitSetPresentationMode("inline");
		return;
	}
	if (isFunction(document.exitPictureInPicture)) return document.exitPictureInPicture();
	const video = media;
	if (isFunction(video.exitPictureInPicture)) return video.exitPictureInPicture();
}

//#endregion
//#region ../core/dist/default/dom/store/features/fullscreen.js
const fullscreenFeature = definePlayerFeature({
	name: "fullscreen",
	state: ({ target }) => ({
		fullscreen: false,
		fullscreenAvailability: "unavailable",
		async requestFullscreen() {
			const { media, container } = target();
			if (isPictureInPicture(media)) await exitPictureInPicture(media);
			return requestFullscreen(container, media);
		},
		async exitFullscreen() {
			const { media } = target();
			return exitFullscreen(media);
		},
		async toggleFullscreen() {
			const { media, container } = target();
			if (isFullscreen(container, media)) return exitFullscreen(media);
			if (isPictureInPicture(media)) await exitPictureInPicture(media);
			return requestFullscreen(container, media);
		}
	}),
	attach({ target, signal, set }) {
		const { media, container } = target;
		set({ fullscreenAvailability: isFullscreenEnabled() ? "available" : "unsupported" });
		const sync = () => set({ fullscreen: isFullscreen(container, media) });
		sync();
		listen(document, "fullscreenchange", sync, { signal });
		listen(document, "webkitfullscreenchange", sync, { signal });
		if ("webkitPresentationMode" in media) listen(media, "webkitpresentationmodechanged", sync, { signal });
	}
});

//#endregion
//#region ../core/dist/default/dom/store/features/live.js
/**
* Player feature exposing `liveEdgeStart` and `targetLiveWindow` in store
* state for media that implements `MediaLiveCapability` (currently
* `HlsJsMedia` and its delegates).
*
* - `liveEdgeStart` — presentation time marking the start of the Live Edge
*   Window. Playing at the live edge when `currentTime >= liveEdgeStart`.
*   `NaN` when the stream isn't live or the value is unknown.
* - `targetLiveWindow` — `0` for standard latency live, `Infinity` for DVR,
*   `NaN` for on-demand or unknown.
*
* Included by the {@link liveVideoFeatures} and {@link liveAudioFeatures}
* presets; apps can also compose it into a custom preset.
*
* @see https://github.com/video-dev/media-ui-extensions/blob/main/proposals/0007-live-edge.md
*/
const liveFeature = definePlayerFeature({
	name: "live",
	state: () => ({
		liveEdgeStart: NaN,
		targetLiveWindow: NaN
	}),
	attach({ target, signal, set }) {
		const { media } = target;
		if (!isMediaLiveCapable(media)) return;
		const sync = () => set({
			liveEdgeStart: media.liveEdgeStart,
			targetLiveWindow: media.targetLiveWindow
		});
		sync();
		listen(media, "targetlivewindowchange", sync, { signal });
		listen(media, "streamtypechange", sync, { signal });
		listen(media, "loadedmetadata", sync, { signal });
		listen(media, "canplay", sync, { signal });
		listen(media, "progress", sync, { signal });
		listen(media, "durationchange", sync, { signal });
		listen(media, "timeupdate", sync, { signal });
		listen(media, "emptied", sync, { signal });
	}
});

//#endregion
//#region ../core/dist/default/dom/store/features/metadata.js
const MEDIA_CONTENT_TITLE = Symbol("@videojs/media-content-title");
const USER_CONTENT_TITLE = Symbol("@videojs/user-content-title");
const USER_DEFAULT_CONTENT_TITLE = Symbol("@videojs/user-default-content-title");
const SET_USER_CONTENT_TITLE = Symbol("@videojs/set-user-content-title");
const SET_USER_DEFAULT_CONTENT_TITLE = Symbol("@videojs/set-user-default-content-title");
const DEFAULT_CONTENT_TITLE = "";
/**
* Resolves user, media, and fallback content-title metadata into player state.
* Included in the standard audio, video, and live presets.
*/
const metadataFeature = definePlayerFeature({
	name: "metadata",
	config: {
		contentTitle: {
			action: SET_USER_CONTENT_TITLE,
			state: USER_CONTENT_TITLE
		},
		defaultContentTitle: {
			action: SET_USER_DEFAULT_CONTENT_TITLE,
			state: USER_DEFAULT_CONTENT_TITLE
		}
	},
	state: ({ set }) => ({
		[MEDIA_CONTENT_TITLE]: void 0,
		[USER_CONTENT_TITLE]: void 0,
		[USER_DEFAULT_CONTENT_TITLE]: void 0,
		[SET_USER_CONTENT_TITLE]: (value) => set({ [USER_CONTENT_TITLE]: value }),
		[SET_USER_DEFAULT_CONTENT_TITLE]: (value) => set({ [USER_DEFAULT_CONTENT_TITLE]: value }),
		setContentTitle: (value) => set({ [USER_CONTENT_TITLE]: value }),
		setDefaultContentTitle: (value) => set({ [USER_DEFAULT_CONTENT_TITLE]: value })
	}),
	derived: { contentTitle: ({ get }) => get()[USER_CONTENT_TITLE] ?? get()[MEDIA_CONTENT_TITLE] ?? get()[USER_DEFAULT_CONTENT_TITLE] ?? DEFAULT_CONTENT_TITLE },
	attach({ target, signal, set }) {
		const { media } = target;
		if (!isMediaContentDataCapable(media)) return;
		const sync = () => set({ [MEDIA_CONTENT_TITLE]: media.contentData?.title });
		sync();
		listen(media, "contentdatachange", sync, { signal });
	}
});

//#endregion
//#region ../core/dist/default/dom/store/features/pip.js
const pipFeature = definePlayerFeature({
	name: "pip",
	state: ({ target }) => ({
		pip: false,
		pipAvailability: "unavailable",
		async requestPictureInPicture() {
			const { media, container } = target();
			if (isFullscreen(container, media)) await exitFullscreen(media);
			return requestPictureInPicture(media);
		},
		async exitPictureInPicture() {
			const { media } = target();
			return exitPictureInPicture(media);
		},
		async togglePictureInPicture() {
			const { media, container } = target();
			if (isPictureInPicture(media)) return exitPictureInPicture(media);
			if (isFullscreen(container, media)) await exitFullscreen(media);
			return requestPictureInPicture(media);
		}
	}),
	attach({ target, signal, set }) {
		const { media } = target;
		set({ pipAvailability: isPictureInPictureEnabled() && isPictureInPictureCapable(media) ? "available" : "unsupported" });
		const sync = () => set({ pip: isPictureInPicture(media) });
		sync();
		listen(media, "enterpictureinpicture", sync, { signal });
		listen(media, "leavepictureinpicture", sync, { signal });
		if ("webkitPresentationMode" in media) listen(media, "webkitpresentationmodechanged", sync, { signal });
	}
});

//#endregion
//#region ../core/dist/default/dom/store/features/playback.js
const playbackFeature = definePlayerFeature({
	name: "playback",
	state: ({ target }) => ({
		paused: true,
		ended: false,
		started: false,
		waiting: false,
		play() {
			return target().media.play();
		},
		pause() {
			const { media } = target();
			if (isMediaPauseCapable(media)) media.pause();
		},
		togglePaused() {
			const media = target().media;
			if (!isMediaPauseCapable(media)) return false;
			if (media.paused) {
				media.play();
				return true;
			}
			media.pause();
			return false;
		}
	}),
	attach({ target, signal, set }) {
		const { media } = target;
		if (!isMediaPauseCapable(media) || !isMediaSeekCapable(media) || !isMediaSourceCapable(media)) return;
		const sync = () => set({
			paused: media.paused,
			ended: media.ended,
			started: !media.paused || media.currentTime > 0,
			waiting: media.readyState < HTMLMediaElement.HAVE_FUTURE_DATA && !media.paused
		});
		sync();
		listen(media, "emptied", sync, { signal });
		listen(media, "play", sync, { signal });
		listen(media, "pause", sync, { signal });
		listen(media, "ended", sync, { signal });
		listen(media, "playing", sync, { signal });
		listen(media, "waiting", sync, { signal });
		listen(media, "seeked", sync, { signal });
	}
});

//#endregion
//#region ../core/dist/default/dom/store/features/playback-rate.js
const DEFAULT_RATES = [
	.2,
	.5,
	.7,
	1,
	1.2,
	1.5,
	1.7,
	2
];
const playbackRateFeature = definePlayerFeature({
	name: "playbackRate",
	state: ({ target }) => ({
		playbackRates: DEFAULT_RATES,
		playbackRate: 1,
		setPlaybackRate(rate) {
			const { media } = target();
			if (isMediaPlaybackRateCapable(media)) media.playbackRate = rate;
		}
	}),
	attach({ target, signal, set }) {
		const { media } = target;
		if (!isMediaPlaybackRateCapable(media)) return;
		const sync = () => set({ playbackRate: media.playbackRate });
		sync();
		listen(media, "ratechange", sync, { signal });
	}
});

//#endregion
//#region ../core/dist/default/dom/store/features/quality.js
const QUALITY_AUTO_VALUE$1 = "auto";
function getRenditionValue$1(rendition, index) {
	return rendition.id || String(index);
}
function toMediaRendition(rendition) {
	return {
		...rendition.id !== void 0 && { id: rendition.id },
		...rendition.width !== void 0 && { width: rendition.width },
		...rendition.height !== void 0 && { height: rendition.height },
		...rendition.bitrate !== void 0 && { bitrate: rendition.bitrate },
		...rendition.frameRate !== void 0 && { frameRate: rendition.frameRate },
		...rendition.codec !== void 0 && { codec: rendition.codec },
		selected: rendition.selected
	};
}
function getSize(rendition) {
	if (rendition.width && rendition.height) return Math.min(rendition.width, rendition.height);
	return rendition.height ?? rendition.width;
}
const qualityFeature = definePlayerFeature({
	name: "quality",
	state: ({ target }) => ({
		videoRenditionList: [],
		activeVideoRendition: null,
		selectVideoRendition(value) {
			const { media } = target();
			if (!isMediaVideoRenditionCapable(media)) return;
			if (value === QUALITY_AUTO_VALUE$1) {
				media.videoRenditions.selectedIndex = -1;
				return;
			}
			const index = [...media.videoRenditions].findIndex((rendition, renditionIndex) => getRenditionValue$1(rendition, renditionIndex) === value);
			if (index !== -1) media.videoRenditions.selectedIndex = index;
		}
	}),
	attach({ target, signal, set }) {
		const { media } = target;
		let videoRenditions = null;
		let cleanup = null;
		const getVideoRenditions = () => isMediaVideoRenditionCapable(media) ? media.videoRenditions : null;
		const getActiveRendition = (list) => {
			if (!list) return null;
			const renditions = [...list];
			const active = renditions.find((rendition) => rendition.active);
			if (active) return active;
			if (!isMediaVideoDimensionsCapable(media) || !media.videoWidth && !media.videoHeight) return null;
			const size = getSize({
				width: media.videoWidth || void 0,
				height: media.videoHeight || void 0
			});
			const matches = renditions.filter((rendition) => getSize(rendition) === size);
			return matches.length === 1 ? matches[0] : null;
		};
		const sync = (list = getVideoRenditions()) => {
			const active = getActiveRendition(list);
			set({
				videoRenditionList: list ? [...list].map(toMediaRendition) : [],
				activeVideoRendition: active ? toMediaRendition(active) : null
			});
		};
		const bind = () => {
			const nextVideoRenditions = getVideoRenditions();
			if (nextVideoRenditions === videoRenditions) {
				sync(nextVideoRenditions);
				return;
			}
			cleanup?.abort();
			cleanup = new AbortController();
			videoRenditions = nextVideoRenditions;
			if (videoRenditions) {
				listen(videoRenditions, "addrendition", () => sync(videoRenditions), { signal: cleanup.signal });
				listen(videoRenditions, "removerendition", () => sync(videoRenditions), { signal: cleanup.signal });
				listen(videoRenditions, "change", () => sync(videoRenditions), { signal: cleanup.signal });
				listen(videoRenditions, "activechange", () => sync(videoRenditions), { signal: cleanup.signal });
			}
			sync(videoRenditions);
		};
		bind();
		listen(media, "loadstart", bind, { signal });
		listen(media, "resize", () => sync(videoRenditions), { signal });
		signal.addEventListener("abort", () => cleanup?.abort(), { once: true });
	}
});

//#endregion
//#region ../core/dist/default/dom/store/features/remote-playback.js
const remotePlaybackFeature = definePlayerFeature({
	name: "remotePlayback",
	state: ({ target }) => ({
		remotePlaybackState: "disconnected",
		remotePlaybackAvailability: "unsupported",
		async toggleRemotePlayback() {
			const { media, container } = target();
			if (isRemotePlaybackConnected(media)) return requestRemotePlayback(media);
			if (isFullscreen(container, media)) await exitFullscreen(media);
			return await requestRemotePlayback(media);
		}
	}),
	attach({ target, signal, set }) {
		const { media } = target;
		if (!isMediaRemotePlaybackCapable(media)) return;
		if (isWebKitAirPlayCapable(media)) {
			const syncConnection = () => {
				set({ remotePlaybackState: media.webkitCurrentPlaybackTargetIsWireless ? "connected" : "disconnected" });
			};
			const syncAvailability = (event) => {
				const { availability } = event;
				set({ remotePlaybackAvailability: availability === "available" ? "available" : "unavailable" });
			};
			listen(media, "webkitplaybacktargetavailabilitychanged", syncAvailability, { signal });
			listen(media, "webkitcurrentplaybacktargetiswirelesschanged", syncConnection, { signal });
			syncConnection();
			return;
		}
		const syncState = () => set({ remotePlaybackState: media.remote.state });
		syncState();
		listen(media.remote, "connect", syncState, { signal });
		listen(media.remote, "connecting", syncState, { signal });
		listen(media.remote, "disconnect", syncState, { signal });
		media.remote.watchAvailability((available) => {
			set({ remotePlaybackAvailability: available ? "available" : "unavailable" });
		}).catch(() => {
			set({ remotePlaybackAvailability: "unsupported" });
		});
		signal.addEventListener("abort", () => {
			media.remote?.cancelWatchAvailability?.().catch(() => {});
		});
	}
});

//#endregion
//#region ../core/dist/default/dom/store/features/source.js
const sourceFeature = definePlayerFeature({
	name: "source",
	state: ({ target, signals }) => ({
		source: null,
		canPlay: false,
		loadSource(src) {
			signals.clear();
			const { media } = target();
			if (!isMediaSourceCapable(media)) return src;
			media.src = src;
			media.load();
			return src;
		}
	}),
	attach({ target, signal, set }) {
		const { media } = target;
		if (!isMediaSourceCapable(media)) return;
		const sync = () => set({
			source: media.currentSrc || media.src || null,
			canPlay: media.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA
		});
		sync();
		listen(media, "canplay", sync, { signal });
		listen(media, "canplaythrough", sync, { signal });
		listen(media, "loadstart", sync, { signal });
		listen(media, "emptied", sync, { signal });
	}
});

//#endregion
//#region ../core/dist/default/dom/store/features/stream-type.js
const streamTypeFeature = definePlayerFeature({
	name: "streamType",
	state: () => ({ streamType: MediaStreamTypes.UNKNOWN }),
	attach({ target, signal, set }) {
		const { media } = target;
		if (isMediaStreamTypeCapable(media)) {
			const sync = () => set({ streamType: media.streamType });
			sync();
			listen(media, "streamtypechange", sync, { signal });
			return;
		}
		if (!isMediaSeekCapable(media)) return;
		const detect = () => {
			const { duration } = media;
			if (duration === Number.POSITIVE_INFINITY) return MediaStreamTypes.LIVE;
			if (Number.isFinite(duration) && duration > 0) return MediaStreamTypes.ON_DEMAND;
			return MediaStreamTypes.UNKNOWN;
		};
		const sync = () => set({ streamType: detect() });
		sync();
		listen(media, "durationchange", sync, { signal });
		listen(media, "loadedmetadata", sync, { signal });
		listen(media, "emptied", sync, { signal });
		if (isMediaBufferCapable(media)) listen(media, "progress", sync, { signal });
	}
});

//#endregion
//#region ../core/dist/default/dom/store/features/text-track.js
function getTrackId(track, index) {
	return track.id || `track:${index}:${track.kind}:${track.language}:${track.label}`;
}
/**
* Caption/subtitle tracks paired with the ids exposed through `textTrackList`,
* ordered like the captions menu so index-based fallbacks agree with the UI.
*/
function getSubtitlesTracks(media) {
	return Array.from(media.textTracks).map((track, index) => ({
		id: getTrackId(track, index),
		track
	})).filter(({ track }) => isCaptionOrSubtitleTrack(track)).sort((a, b) => a.track.kind > b.track.kind ? 1 : a.track.kind < b.track.kind ? -1 : 0);
}
/** Show at most one caption/subtitle track; passing `null` disables them all. */
function showOnly(tracks, active) {
	for (const { track } of tracks) {
		const mode = track === active ? "showing" : "disabled";
		if (track.mode !== mode) track.mode = mode;
	}
}
const textTrackFeature = definePlayerFeature({
	name: "textTrack",
	state: ({ target }) => {
		let lastShownId = null;
		return {
			chaptersCues: [],
			thumbnailCues: [],
			thumbnailTrackSrc: null,
			textTrackList: [],
			subtitlesShowing: false,
			toggleSubtitles(forceShow) {
				const { media } = target();
				if (!isMediaTextTrackCapable(media)) return false;
				const subtitlesTracks = getSubtitlesTracks(media);
				if (!subtitlesTracks.length) return false;
				const showing = subtitlesTracks.find(({ track }) => track.mode === "showing");
				const nextShowing = forceShow ?? !showing;
				if (showing) lastShownId = showing.id;
				if (!nextShowing) {
					showOnly(subtitlesTracks, null);
					return false;
				}
				const next = showing ?? subtitlesTracks.find(({ id }) => id === lastShownId) ?? subtitlesTracks[0];
				lastShownId = next.id;
				showOnly(subtitlesTracks, next.track);
				return true;
			},
			selectSubtitlesTrack(value) {
				const { media } = target();
				if (!isMediaTextTrackCapable(media)) return;
				const subtitlesTracks = getSubtitlesTracks(media);
				if (!subtitlesTracks.length) return;
				if (value === "off") {
					const showing = subtitlesTracks.find(({ track }) => track.mode === "showing");
					if (showing) lastShownId = showing.id;
					showOnly(subtitlesTracks, null);
					return;
				}
				const active = subtitlesTracks.find(({ id }) => id === value);
				if (!active) return;
				lastShownId = active.id;
				showOnly(subtitlesTracks, active.track);
			}
		};
	},
	attach({ target, signal, set }) {
		const { media } = target;
		if (!isMediaTextTrackCapable(media)) return;
		let trackCleanup = null;
		const sync = () => {
			trackCleanup?.abort();
			trackCleanup = new AbortController();
			let chaptersTrack = null;
			let thumbnailTrack = null;
			const textTrackList = [];
			let subtitlesShowing = false;
			for (let i = 0; i < media.textTracks.length; i++) {
				const track = media.textTracks[i];
				if (!chaptersTrack && track.kind === "chapters") chaptersTrack = track;
				if (!thumbnailTrack && track.kind === "metadata" && track.label === "thumbnails") thumbnailTrack = track;
				textTrackList.push({
					id: getTrackId(track, i),
					kind: track.kind,
					label: track.label,
					language: track.language,
					mode: track.mode
				});
				if (isCaptionOrSubtitleTrack(track) && track.mode === "showing") subtitlesShowing = true;
			}
			const chaptersCues = chaptersTrack?.cues ? Array.from(chaptersTrack.cues) : [];
			const thumbnailCues = thumbnailTrack?.cues ? Array.from(thumbnailTrack.cues) : [];
			let thumbnailTrackSrc = null;
			if (thumbnailTrack) thumbnailTrackSrc = findTrackElement(media, thumbnailTrack)?.src ?? null;
			const tracks = isQuerySelectorAllCapable(media) && media.querySelectorAll("track") || [];
			const shadowTracks = media instanceof HTMLElement && media.shadowRoot?.querySelectorAll("track") || [];
			for (const trackEl of [...tracks, ...shadowTracks]) if (!trackEl.track?.cues?.length) listen(trackEl, "load", sync, { signal: trackCleanup.signal });
			set({
				chaptersCues,
				thumbnailCues,
				thumbnailTrackSrc,
				textTrackList,
				subtitlesShowing
			});
		};
		sync();
		const textTracks = media.textTracks;
		if (textTracks instanceof EventTarget) {
			listen(textTracks, "addtrack", sync, { signal });
			listen(textTracks, "removetrack", sync, { signal });
			listen(textTracks, "change", sync, { signal });
		}
		listen(media, "loadstart", sync, { signal });
		signal.addEventListener("abort", () => trackCleanup?.abort(), { once: true });
	}
});

//#endregion
//#region ../core/dist/default/dom/store/signal-keys.js
const signalKeys = { seek: Symbol.for("@videojs/seek") };

//#endregion
//#region ../core/dist/default/dom/store/features/time.js
const timeFeature = definePlayerFeature({
	name: "time",
	state: ({ target, signals, set }) => ({
		currentTime: 0,
		duration: 0,
		seeking: false,
		async seek(time) {
			const { media } = target(), signal = signals.supersede(signalKeys.seek);
			if (!isMediaSeekCapable(media) || !isMediaSourceCapable(media)) return 0;
			if (!hasMetadata(media)) {
				if (!await onEvent(media, "loadedmetadata", { signal }).catch(() => false)) return media.currentTime;
			}
			const clampedTime = Math.max(0, Math.min(time, media.duration || Infinity));
			set({
				currentTime: clampedTime,
				seeking: true
			});
			media.currentTime = clampedTime;
			await onEvent(media, "seeked", { signal }).catch(noop);
			return media.currentTime;
		}
	}),
	attach({ target, signal, set, get }) {
		const { media } = target;
		if (!isMediaSeekCapable(media)) return;
		const resolveDuration = () => {
			const { duration } = media;
			if (duration === Number.POSITIVE_INFINITY && isMediaBufferCapable(media)) {
				const { seekable } = media;
				return seekable.length > 0 ? seekable.end(seekable.length - 1) : 0;
			}
			return Number.isFinite(duration) ? duration : 0;
		};
		const sync = () => set({
			currentTime: media.currentTime,
			duration: resolveDuration(),
			seeking: media.seeking
		});
		const syncUnlessSeeking = () => {
			if (get().seeking) return;
			sync();
		};
		sync();
		listen(media, "timeupdate", syncUnlessSeeking, { signal });
		listen(media, "durationchange", sync, { signal });
		listen(media, "seeking", sync, { signal });
		listen(media, "seeked", sync, { signal });
		listen(media, "loadedmetadata", sync, { signal });
		listen(media, "emptied", sync, { signal });
		listen(media, "progress", syncUnlessSeeking, { signal });
	}
});

//#endregion
//#region ../core/dist/default/dom/store/features/volume.js
/** Volume to restore when unmuting at zero. */
const UNMUTE_VOLUME = .25;
const volumeFeature = definePlayerFeature({
	name: "volume",
	state: ({ target }) => ({
		volume: 1,
		muted: false,
		volumeAvailability: "unavailable",
		mutedAvailability: "unavailable",
		setVolume(volume) {
			const { media } = target();
			if (!isMediaVolumeCapable(media)) return 0;
			const clamped = Math.max(0, Math.min(1, volume));
			if (clamped > 0 && media.muted) media.muted = false;
			media.volume = clamped;
			return media.volume;
		},
		toggleMuted() {
			const { media } = target();
			if (!isMediaMutedCapable(media)) return false;
			if (!isMediaVolumeCapable(media)) {
				media.muted = !media.muted;
				return media.muted;
			}
			if (media.muted || media.volume === 0) {
				media.muted = false;
				if (media.volume === 0) media.volume = UNMUTE_VOLUME;
			} else media.muted = true;
			return media.muted;
		}
	}),
	attach({ target, signal, set }) {
		const { media } = target;
		const volumeCapable = isMediaVolumeCapable(media);
		const mutedCapable = isMediaMutedCapable(media);
		if (!volumeCapable && !mutedCapable) return;
		set({
			volumeAvailability: volumeCapable ? canSetVolume() : "unavailable",
			mutedAvailability: mutedCapable ? "available" : "unavailable"
		});
		const sync = () => set({
			volume: volumeCapable ? media.volume : 1,
			muted: mutedCapable ? media.muted : false
		});
		sync();
		listen(media, "volumechange", sync, { signal });
	}
});
/** Check if volume can be programmatically set (fails on iOS Safari). */
function canSetVolume() {
	const video = document.createElement("video");
	try {
		video.volume = .5;
		return video.volume === .5 ? "available" : "unsupported";
	} catch {
		return "unsupported";
	}
}

//#endregion
//#region ../core/dist/default/dom/store/selectors.js
/** Select the audio track state (audioTrackList, selectAudioTrack). */
const selectAudioTrack = createSelector(audioTrackFeature);
/** Select the buffer state (buffered ranges, percent buffered). */
const selectBuffer = createSelector(bufferFeature);
/** Select the controls state (controls visible, user-active). */
const selectControls = createSelector(controlsFeature);
/** Select the error state (error, dismissed, dismissError). */
const selectError = createSelector(errorFeature);
/** Select the fullscreen state (fullscreen active, availability). */
const selectFullscreen = createSelector(fullscreenFeature);
/** Select the live state (`liveEdgeStart`, `targetLiveWindow`). */
const selectLive = createSelector(liveFeature);
/** Select resolved content metadata and its user-config writers. */
const selectMetadata = createSelector(metadataFeature);
/** Select the PiP state (picture-in-picture active, availability). */
const selectPiP = createSelector(pipFeature);
/** Select the playback state (paused, ended, play, pause, toggle). */
const selectPlayback = createSelector(playbackFeature);
/** Select the playback rate state (playbackRate, playbackRates, setPlaybackRate). */
const selectPlaybackRate = createSelector(playbackRateFeature);
/** Select the quality state (videoRenditionList, activeVideoRendition, selectVideoRendition). */
const selectQuality = createSelector(qualityFeature);
/** Select the remote playback state (remote playback connection state, availability). */
const selectRemotePlayback = createSelector(remotePlaybackFeature);
/** Select the source state (src, type). */
const selectSource = createSelector(sourceFeature);
/** Select the stream type state (`'on-demand' | 'live' | 'unknown'`). */
const selectStreamType = createSelector(streamTypeFeature);
/** Select the text track state (chapters cues, thumbnail cues). */
const selectTextTrack = createSelector(textTrackFeature);
/** Select the time state (currentTime, duration, seek). */
const selectTime = createSelector(timeFeature);
/** Select the volume state (volume, muted, setVolume, setMuted). */
const selectVolume = createSelector(volumeFeature);

//#endregion
//#region ../core/dist/default/dom/media-actions.js
const MEDIA_INPUT_ACTION_OVERRIDES = {
	seekStep({ store, value }) {
		if (isUndefined(value)) return;
		const time = selectTime(store.state);
		if (!time) return;
		time.seek(time.currentTime + value);
	},
	volumeStep({ store, value }) {
		if (isUndefined(value)) return;
		const vol = selectVolume(store.state);
		if (!vol) return;
		vol.setVolume(vol.volume + value);
	},
	speedUp({ store }) {
		const rate = selectPlaybackRate(store.state);
		if (!rate) return;
		const { playbackRates, playbackRate } = rate;
		const idx = playbackRates.indexOf(playbackRate);
		const next = idx < 0 || idx >= playbackRates.length - 1 ? 0 : idx + 1;
		rate.setPlaybackRate(playbackRates[next]);
	},
	speedDown({ store }) {
		const rate = selectPlaybackRate(store.state);
		if (!rate) return;
		const { playbackRates, playbackRate } = rate;
		const idx = playbackRates.indexOf(playbackRate);
		const next = idx <= 0 ? playbackRates.length - 1 : idx - 1;
		rate.setPlaybackRate(playbackRates[next]);
	}
};

//#endregion
//#region ../core/dist/default/dom/gesture/actions.js
/** Actions that need custom logic beyond `store.state[action]()`. */
const GESTURE_ACTION_OVERRIDES = {
	seekStep: MEDIA_INPUT_ACTION_OVERRIDES.seekStep,
	volumeStep: MEDIA_INPUT_ACTION_OVERRIDES.volumeStep,
	speedUp: MEDIA_INPUT_ACTION_OVERRIDES.speedUp,
	speedDown: MEDIA_INPUT_ACTION_OVERRIDES.speedDown
};
function resolveGestureAction(name) {
	const override = GESTURE_ACTION_OVERRIDES[name];
	if (override) return override;
	return ({ store }) => {
		const method = store.state[name];
		if (isFunction(method)) method();
	};
}

//#endregion
//#region ../core/dist/default/dom/gesture/tap.js
const DOUBLETAP_WINDOW = 200;
/**
* Recognizes tap vs doubletap from quick pointer-up events.
*
* Stateful recognizer — tracks tap count and doubletap timing.
* The coordinator handles pointer-down timing (tap threshold) and
* calls `handleUp()` only for quick taps that passed the threshold check.
*/
var TapRecognizer = class {
	#lastTapTime = 0;
	#tapTimer = null;
	handleUp(matches, event) {
		if (matches.resolve("doubletap").length > 0) {
			const now = Date.now();
			if (now - this.#lastTapTime < DOUBLETAP_WINDOW) {
				this.#clearTimer();
				this.#lastTapTime = 0;
				matches.resolve("doubletap")[0]?.onActivate(event);
				return;
			}
			this.#lastTapTime = now;
			this.#clearTimer();
			this.#tapTimer = setTimeout(() => {
				this.#tapTimer = null;
				this.#lastTapTime = 0;
				matches.resolve("tap")[0]?.onActivate(event);
			}, DOUBLETAP_WINDOW);
			return;
		}
		matches.resolve("tap")[0]?.onActivate(event);
	}
	#clearTimer() {
		if (this.#tapTimer !== null) {
			clearTimeout(this.#tapTimer);
			this.#tapTimer = null;
		}
	}
	reset() {
		this.#clearTimer();
		this.#lastTapTime = 0;
	}
};

//#endregion
//#region ../core/dist/default/dom/gesture/create-tap-gesture.js
const recognizers = /* @__PURE__ */ new WeakMap();
function getRecognizer(target) {
	let recognizer = recognizers.get(target);
	if (recognizer) return recognizer;
	recognizer = new TapRecognizer();
	recognizers.set(target, recognizer);
	return recognizer;
}
/**
* Register a tap gesture on a target element.
*
* @example
* ```ts
* const cleanup = createTapGesture(container, (event) => {
*   store.paused ? store.play() : store.pause();
* }, { pointer: 'mouse' });
* ```
*/
function createTapGesture(target, onActivate, options) {
	return getGestureCoordinator(target).add({
		type: "tap",
		recognizer: getRecognizer(target),
		onActivate,
		pointer: options?.pointer,
		region: options?.region,
		disabled: options?.disabled,
		action: options?.action,
		value: options?.value
	});
}
/**
* Register a doubletap gesture on a target element.
*
* @example
* ```ts
* const cleanup = createDoubleTapGesture(container, (event) => {
*   store.fullscreen ? store.exitFullscreen() : store.requestFullscreen();
* }, { region: 'center' });
* ```
*/
function createDoubleTapGesture(target, onActivate, options) {
	return getGestureCoordinator(target).add({
		type: "doubletap",
		recognizer: getRecognizer(target),
		onActivate,
		pointer: options?.pointer,
		region: options?.region,
		disabled: options?.disabled,
		action: options?.action,
		value: options?.value
	});
}

//#endregion
//#region ../core/dist/default/dom/hotkey/actions.js
function isHotkeyToggleAction(action) {
	return action.startsWith("toggle");
}
const HOTKEY_ACTIONS = {
	togglePaused({ store }) {
		const playback = selectPlayback(store.state);
		if (!playback) return;
		playback.paused ? playback.play() : playback.pause();
	},
	toggleMuted({ store }) {
		selectVolume(store.state)?.toggleMuted();
	},
	toggleFullscreen({ store }) {
		const fs = selectFullscreen(store.state);
		if (!fs) return;
		fs.fullscreen ? fs.exitFullscreen() : fs.requestFullscreen();
	},
	toggleSubtitles({ store }) {
		selectTextTrack(store.state)?.toggleSubtitles();
	},
	togglePictureInPicture({ store }) {
		const pip = selectPiP(store.state);
		if (!pip) return;
		pip.pip ? pip.exitPictureInPicture() : pip.requestPictureInPicture();
	},
	seekStep: MEDIA_INPUT_ACTION_OVERRIDES.seekStep,
	volumeStep: MEDIA_INPUT_ACTION_OVERRIDES.volumeStep,
	speedUp: MEDIA_INPUT_ACTION_OVERRIDES.speedUp,
	speedDown: MEDIA_INPUT_ACTION_OVERRIDES.speedDown,
	seekToPercent({ store, value, key }) {
		const time = selectTime(store.state);
		if (!time || time.duration <= 0) return;
		let percent;
		if (!isUndefined(value)) percent = value;
		else if (key >= "0" && key <= "9") percent = Number(key) * 10;
		else return;
		time.seek(percent / 100 * time.duration);
	}
};
function resolveHotkeyAction(name) {
	return HOTKEY_ACTIONS[name];
}

//#endregion
//#region ../core/dist/default/dom/hotkey/aria.js
const ARIA_MODIFIER_MAP = {
	shift: "Shift",
	ctrl: "Control",
	alt: "Alt",
	meta: "Meta"
};
const DISPLAY_MODIFIER_MAP = {
	shift: "Shift",
	ctrl: "Ctrl",
	alt: "Alt",
	meta: "Meta"
};
const MODIFIER_ORDER = [
	"ctrl",
	"shift",
	"alt",
	"meta"
];
/**
* Convert parsed key bindings to a WAI-ARIA `aria-keyshortcuts` formatted string.
*
* @example
* ```ts
* toAriaKeyShortcut(parseHotkeyPattern('Ctrl+Shift+f'));
* // "Control+Shift+f"
*
* toAriaKeyShortcut([...parseHotkeyPattern('k'), ...parseHotkeyPattern('Space')]);
* // "k Space"
* ```
*/
function toAriaKeyShortcut(bindings) {
	return bindings.map((b) => {
		const parts = [];
		for (const mod of MODIFIER_ORDER) if (b.modifiers.has(mod)) parts.push(ARIA_MODIFIER_MAP[mod]);
		parts.push(b.originalKey);
		return parts.join("+");
	}).join(" ");
}
/** Convert a parsed key binding to a compact display shortcut. */
function toDisplayKeyShortcut(binding) {
	const parts = [];
	for (const mod of MODIFIER_ORDER) if (binding.modifiers.has(mod)) parts.push(DISPLAY_MODIFIER_MAP[mod]);
	parts.push(toDisplayKey(binding.originalKey));
	return parts.join("+");
}
function toDisplayKey(key) {
	return key.length === 1 ? key.toUpperCase() : key;
}

//#endregion
//#region ../core/dist/default/dom/hotkey/coordinator.js
var HotkeyCoordinator = class {
	#target;
	#bindings = [];
	#nextId = 0;
	#disconnect = null;
	#docDisconnect = null;
	#activationSubscribers = /* @__PURE__ */ new Set();
	#shortcutSubscribers = /* @__PURE__ */ new Set();
	#destroyed = false;
	constructor(target) {
		this.#target = target;
	}
	subscribe(callback) {
		this.#activationSubscribers.add(callback);
		return () => this.#activationSubscribers.delete(callback);
	}
	subscribeShortcutChanges(callback) {
		this.#shortcutSubscribers.add(callback);
		return () => this.#shortcutSubscribers.delete(callback);
	}
	add(options) {
		const binding = {
			parsed: parseHotkeyPattern(options.keys),
			options,
			id: this.#nextId++
		};
		this.#bindings.push(binding);
		this.#sortBindings();
		if (options.target === "document") this.#connectDocument();
		else this.#connect();
		this.#notify();
		let removed = false;
		return () => {
			if (removed) return;
			removed = true;
			const idx = this.#bindings.indexOf(binding);
			if (idx !== -1) this.#bindings.splice(idx, 1);
			this.#maybeDisconnect();
			this.#notify();
		};
	}
	getAriaKeys(action) {
		return this.getShortcut(action).aria;
	}
	getShortcut(action, value) {
		const bindings = this.#getActionBindings(action, value);
		if (!bindings.length) return {};
		const parsed = bindings.flatMap((binding) => binding.parsed);
		const preferred = bindings[bindings.length - 1];
		return {
			aria: toAriaKeyShortcut(parsed),
			shortcut: this.#formatDisplayShortcut(preferred)
		};
	}
	destroy() {
		if (this.#destroyed) return;
		this.#destroyed = true;
		this.#disconnect?.abort();
		this.#disconnect = null;
		this.#docDisconnect?.abort();
		this.#docDisconnect = null;
		this.#bindings = [];
		this.#notify();
		this.#activationSubscribers.clear();
		this.#shortcutSubscribers.clear();
	}
	#sortBindings() {
		this.#bindings.sort((a, b) => {
			const specDiff = b.parsed[0].modifiers.size - a.parsed[0].modifiers.size;
			if (specDiff !== 0) return specDiff;
			return a.id - b.id;
		});
	}
	#connect() {
		if (this.#disconnect) return;
		this.#disconnect = new AbortController();
		listen(this.#target, "keydown", this.#handleEvent, { signal: this.#disconnect.signal });
	}
	#connectDocument() {
		if (this.#docDisconnect) return;
		this.#docDisconnect = new AbortController();
		listen(document, "keydown", this.#handleEvent, { signal: this.#docDisconnect.signal });
	}
	#maybeDisconnect() {
		const hasPlayer = this.#bindings.some((b) => b.options.target !== "document");
		const hasDoc = this.#bindings.some((b) => b.options.target === "document");
		if (!hasPlayer) {
			this.#disconnect?.abort();
			this.#disconnect = null;
		}
		if (!hasDoc) {
			this.#docDisconnect?.abort();
			this.#docDisconnect = null;
		}
	}
	#handleEvent = (event) => {
		if (event.key === "Unidentified") return;
		if (isInteractiveActivation(event)) return;
		if (event.defaultPrevented) return;
		const editable = isEditableTarget(event);
		for (const binding of this.#bindings) {
			const { options, parsed } = binding;
			if (options.disabled) continue;
			if (event.repeat && options.repeatable === false) continue;
			if (options.target === "document" !== (event.currentTarget === document)) continue;
			for (const p of parsed) {
				if (!matchesHotkeyEvent(p, event)) continue;
				if (editable && p.modifiers.size === 0) continue;
				if (this.#activationSubscribers.size > 0) {
					const activateEvent = {
						source: "hotkey",
						action: options.action,
						value: options.value,
						event
					};
					for (const cb of this.#activationSubscribers) try {
						cb(activateEvent);
					} catch (error) {}
				}
				event.preventDefault();
				options.onActivate(event, p.originalKey);
				return;
			}
		}
	};
	#getActionBindings(action, value) {
		return this.#bindings.filter((binding) => {
			if (binding.options.disabled) return false;
			if (binding.options.action !== action) return false;
			if (isUndefined(value)) return true;
			return binding.options.value === value;
		}).sort((a, b) => a.id - b.id);
	}
	#formatDisplayShortcut(binding) {
		if (binding.options.keys === "0-9") return binding.options.keys;
		return toDisplayKeyShortcut(binding.parsed[0]);
	}
	#notify() {
		for (const subscriber of this.#shortcutSubscribers) subscriber();
	}
};

//#endregion
//#region ../core/dist/default/dom/hotkey/hotkey.js
const MODIFIER_KEYS = /* @__PURE__ */ new Set([
	"shift",
	"ctrl",
	"alt",
	"meta"
]);
/**
* Parse a key pattern string into one or more bindings.
*
* @example
* ```ts
* parseHotkeyPattern('>');
* // [{ modifiers: Set(), key: '>', originalKey: '>' }]
*
* parseHotkeyPattern('0-9');
* // 10 bindings, one per digit
* ```
*/
function parseHotkeyPattern(pattern) {
	if (pattern === "0-9") return Array.from({ length: 10 }, (_, i) => ({
		modifiers: /* @__PURE__ */ new Set(),
		key: String(i),
		originalKey: String(i)
	}));
	const segments = pattern.split("+");
	const rawKey = segments.pop();
	const modifiers = /* @__PURE__ */ new Set();
	for (const seg of segments) {
		const lower = seg.toLowerCase();
		if (lower === "mod") modifiers.add(isMacOS() ? "meta" : "ctrl");
		else if (MODIFIER_KEYS.has(lower)) modifiers.add(lower);
	}
	return [{
		modifiers,
		key: rawKey === "Space" ? " " : rawKey.toLowerCase(),
		originalKey: rawKey
	}];
}
/**
* Single non-letter character — layout-dependent modifiers (Shift, Alt/Option)
* were used to produce the character itself, not as deliberate modifiers
* (e.g. Shift+. → ">", Option+Shift → ">" on some Mac layouts).
* Letters excluded because Shift changes case intentionally (k vs K).
* Named keys excluded because event.key.length > 1 (ArrowLeft, Tab, etc.).
*/
function isImplicitModifierKey(key) {
	return key.length === 1 && !/[a-z]/i.test(key);
}
/** Whether a parsed binding matches a keyboard event. */
function matchesHotkeyEvent(binding, event) {
	if (event.key === "Unidentified") return false;
	if (event.key.toLowerCase() !== binding.key) return false;
	const implicit = isImplicitModifierKey(event.key);
	const shiftKey = implicit ? event.shiftKey && binding.modifiers.has("shift") : event.shiftKey;
	const altKey = implicit ? event.altKey && binding.modifiers.has("alt") : event.altKey;
	if (shiftKey !== binding.modifiers.has("shift")) return false;
	if (event.ctrlKey !== binding.modifiers.has("ctrl")) return false;
	if (altKey !== binding.modifiers.has("alt")) return false;
	if (event.metaKey !== binding.modifiers.has("meta")) return false;
	return true;
}
const coordinators = /* @__PURE__ */ new WeakMap();
/** Look up or create the hotkey coordinator for a target element. */
function getHotkeyCoordinator(target) {
	let coordinator = coordinators.get(target);
	if (!coordinator) {
		coordinator = new HotkeyCoordinator(target);
		coordinators.set(target, coordinator);
	}
	return coordinator;
}
/**
* Register a hotkey binding on a target element.
*
* @example
* ```ts
* const cleanup = createHotkey(container, {
*   keys: 'k',
*   onActivate: () => store.paused ? store.play() : store.pause(),
* });
*
* // Later: remove the binding
* cleanup();
* ```
*
* @returns A cleanup function that removes the binding.
*/
function createHotkey(target, options) {
	return getHotkeyCoordinator(target).add(options);
}

//#endregion
//#region ../core/dist/default/dom/hotkey/hotkey-events.js
/** Dispatched when display shortcut metadata changes (e.g. coordinator updates). Tooltips may listen. */
const HOTKEY_SHORTCUT_CHANGE_EVENT = "hotkey-shortcut-change";

//#endregion
//#region ../core/dist/default/dom/store/features/presets.js
const videoFeatures = [
	playbackFeature,
	playbackRateFeature,
	qualityFeature,
	audioTrackFeature,
	volumeFeature,
	timeFeature,
	sourceFeature,
	bufferFeature,
	fullscreenFeature,
	pipFeature,
	remotePlaybackFeature,
	controlsFeature,
	textTrackFeature,
	errorFeature,
	metadataFeature
];

//#endregion
//#region ../core/dist/default/dom/ui/dismiss-layer.js
function createDismissLayer(options) {
	const { transition } = options;
	const state = transition.state;
	const abort = new AbortController();
	let docAbort = null;
	function open(element) {
		if (abort.signal.aborted) return null;
		const { active, status } = state.current;
		if (active && status !== "ending") return null;
		if (status === "ending") transition.cancel();
		return transition.open(element);
	}
	function close(element) {
		const { active, status } = state.current;
		if (abort.signal.aborted || !active || status === "ending") return null;
		return transition.close(element);
	}
	function setupDocumentListeners() {
		cleanupDocumentListeners();
		if (typeof document === "undefined") return;
		docAbort = new AbortController();
		const { signal } = docAbort;
		listen(document, "keydown", handleKeydown, { signal });
		options.onDocumentActive?.(signal);
	}
	function cleanupDocumentListeners() {
		docAbort?.abort();
		docAbort = null;
	}
	function handleKeydown(event) {
		if (event.key !== "Escape") return;
		if (event.defaultPrevented) return;
		if (!state.current.active) return;
		if (!(options.closeOnEscape?.() ?? true)) return;
		options.onEscapeDismiss(event);
	}
	const unsubscribe = state.subscribe(() => {
		if (state.current.active) setupDocumentListeners();
		else cleanupDocumentListeners();
	});
	abort.signal.addEventListener("abort", () => {
		unsubscribe();
		transition.destroy();
		cleanupDocumentListeners();
	});
	function destroy() {
		if (abort.signal.aborted) return;
		abort.abort();
	}
	return {
		input: state,
		open,
		close,
		signal: abort.signal,
		destroy
	};
}

//#endregion
//#region ../core/dist/default/dom/ui/alert-dialog.js
function createAlertDialog(options) {
	const { onOpenChange } = options;
	let element = null;
	let previousFocus = null;
	let elementAbort = null;
	const layer = createDismissLayer({
		transition: options.transition,
		closeOnEscape: options.closeOnEscape,
		onEscapeDismiss(event) {
			event.stopPropagation();
			applyClose();
		}
	});
	const state = layer.input;
	function applyOpen() {
		previousFocus = document.activeElement;
		const opening = layer.open();
		if (!opening) return;
		onOpenChange(true);
		requestAnimationFrame(() => {
			if (layer.signal.aborted || !state.current.active) return;
			element?.focus();
		});
		opening.then(() => {
			if (layer.signal.aborted || !state.current.active) return;
			options.onOpenChangeComplete?.(true);
		});
	}
	function applyClose() {
		const closing = layer.close(element);
		if (!closing) return;
		onOpenChange(false);
		closing.then(() => {
			if (layer.signal.aborted) return;
			if (previousFocus) {
				previousFocus.focus();
				previousFocus = null;
			}
			options.onOpenChangeComplete?.(false);
		});
	}
	function setupElementListeners() {
		cleanupElementListeners();
		if (!element) return;
		elementAbort = new AbortController();
		const { signal } = elementAbort;
		listen(element, "click", handleElementClick, { signal });
	}
	function cleanupElementListeners() {
		elementAbort?.abort();
		elementAbort = null;
	}
	function handleElementClick(event) {
		if (event.target instanceof HTMLButtonElement) applyClose();
	}
	function setElement(el) {
		element = el;
		setupElementListeners();
	}
	layer.signal.addEventListener("abort", () => {
		cleanupElementListeners();
		element = null;
		previousFocus = null;
	});
	return {
		input: state,
		open: applyOpen,
		close: applyClose,
		setElement,
		destroy: layer.destroy
	};
}

//#endregion
//#region ../core/dist/default/dom/ui/button.js
function createButton(options) {
	const { onActivate, isDisabled } = options;
	return {
		role: "button",
		tabIndex: 0,
		onClick(event) {
			if (isDisabled()) {
				event.preventDefault();
				return;
			}
			onActivate(event);
		},
		onPointerDown(event) {
			if (isDisabled()) event.preventDefault();
		},
		onMouseDown(event) {
			if (isDisabled()) event.preventDefault();
		},
		onKeyDown(event) {
			if (event.target !== event.currentTarget) return;
			if (isDisabled()) {
				if (event.key !== "Tab") event.preventDefault();
				return;
			}
			if (event.key === "Enter") {
				event.preventDefault();
				onActivate(event);
			} else if (event.key === " ") event.preventDefault();
		},
		onKeyUp(event) {
			if (event.target !== event.currentTarget) return;
			if (isDisabled()) return;
			if (event.key === " ") onActivate(event);
		}
	};
}

//#endregion
//#region ../core/dist/default/dom/ui/container-attrs.js
const DEFAULT_CONTAINER_ROLE = "group";
function applyContainerAttrs(element) {
	if (!element.hasAttribute("role")) element.setAttribute("role", DEFAULT_CONTAINER_ROLE);
	if (!element.hasAttribute("tabindex")) element.setAttribute("tabindex", String(0));
}
function focusContainer(element) {
	const active = getDeepActiveElement(element.ownerDocument);
	if (!active || active === element.ownerDocument.body || !containsComposed(element, active)) element.focus({ preventScroll: true });
}

//#endregion
//#region ../core/dist/default/core/ui/transition.js
/** Shared data attributes for open/close transition state. Spread into component data-attrs objects. */
const TransitionDataAttrs = {
	/** Present during the open transition. */
	transitionStarting: "data-starting-style",
	/** Present during the close transition. */
	transitionEnding: "data-ending-style"
};
function getTransitionFlags(status) {
	return {
		transitionStarting: status === "starting",
		transitionEnding: status === "ending"
	};
}

//#endregion
//#region ../core/dist/default/core/ui/indicator/indicator-lifecycle.js
var IndicatorCloseController = class {
	#timer = null;
	#close;
	#getDelay;
	constructor(close, getDelay) {
		this.#close = close;
		this.#getDelay = getDelay;
	}
	arm() {
		this.clear();
		this.#timer = setTimeout(() => {
			this.#timer = null;
			this.#close();
		}, this.#getDelay());
	}
	clear() {
		if (this.#timer === null) return;
		clearTimeout(this.#timer);
		this.#timer = null;
	}
	close() {
		this.clear();
		this.#close();
	}
	destroy() {
		this.clear();
	}
};
var IndicatorVisibilityCoordinator = class {
	#handles = /* @__PURE__ */ new Set();
	register(handle) {
		this.#handles.add(handle);
		return () => this.#handles.delete(handle);
	}
	show(handle) {
		for (const nextHandle of this.#handles) if (nextHandle !== handle) nextHandle.close();
	}
};
function getIndicatorCloseDelay(props) {
	return props.closeDelay ?? 800;
}
function isIndicatorPresent(current, transition) {
	return current.open || transition.active;
}
function getRenderedIndicatorState(current, snapshot, transition) {
	const payload = current.open ? current : snapshot;
	return {
		...payload,
		open: current.open && transition.active,
		generation: current.open ? current.generation : payload.generation,
		...getTransitionFlags(transition.status)
	};
}

//#endregion
//#region ../core/dist/default/dom/ui/input-action.js
function toInputActionEvent(event) {
	return {
		action: event.action,
		value: event.value,
		source: event.source,
		key: "key" in event.event ? event.event.key : void 0
	};
}
function getMediaSnapshot(store) {
	if (!store) return {};
	const state = store.state;
	const time = selectTime(state);
	const textTrack = selectTextTrack(state);
	return {
		paused: selectPlayback(state)?.paused,
		volume: selectVolume(state)?.volume,
		muted: selectVolume(state)?.muted,
		playbackRate: selectPlaybackRate(state)?.playbackRate,
		fullscreen: selectFullscreen(state)?.fullscreen,
		subtitlesShowing: textTrack?.subtitlesShowing,
		subtitlesAvailable: textTrack ? (textTrack.textTrackList ?? []).some(isCaptionOrSubtitleTrack) : void 0,
		pip: selectPiP(state)?.pip,
		currentTime: time?.currentTime,
		duration: time?.duration,
		seeking: time?.seeking
	};
}
function subscribeToInputActions(container, callback) {
	const handleEvent = (event) => callback(toInputActionEvent(event));
	const gestureUnsubscribe = getGestureCoordinator(container).subscribe(handleEvent);
	const hotkeyUnsubscribe = getHotkeyCoordinator(container).subscribe(handleEvent);
	return () => {
		gestureUnsubscribe();
		hotkeyUnsubscribe();
	};
}
const indicatorVisibilityCoordinators = /* @__PURE__ */ new WeakMap();
function getIndicatorVisibilityCoordinator(container) {
	let coordinator = indicatorVisibilityCoordinators.get(container);
	if (!coordinator) {
		coordinator = new IndicatorVisibilityCoordinator();
		indicatorVisibilityCoordinators.set(container, coordinator);
	}
	return coordinator;
}

//#endregion
//#region ../core/dist/default/dom/ui/popover/popover.js
function createPopover(options) {
	const { onOpenChange, closeOnOutsideClick } = options;
	let triggerEl = null;
	let popupEl = null;
	let hoverTimeout = null;
	const capturedPointers = /* @__PURE__ */ new Set();
	let ignoreNextBlurClose = false;
	let blurGuardTimeout = null;
	const layer = createDismissLayer({
		transition: options.transition,
		closeOnEscape: options.closeOnEscape,
		onEscapeDismiss(event) {
			event.preventDefault();
			applyClose("escape", event);
		},
		onDocumentActive(signal) {
			listen(document, "pointerdown", handleDocumentPointerdown, {
				capture: true,
				signal
			});
		}
	});
	const state = layer.input;
	const groupMember = {
		close(reason) {
			applyClose(reason);
		},
		get triggerElement() {
			return triggerEl;
		}
	};
	function clearHoverTimeout() {
		if (hoverTimeout !== null) {
			clearTimeout(hoverTimeout);
			hoverTimeout = null;
		}
	}
	function canHover() {
		return globalThis.matchMedia?.("(hover: hover)")?.matches ?? false;
	}
	function canOpenOnFocus() {
		if (!canHover()) return false;
		return globalThis.matchMedia?.("(pointer: fine)")?.matches ?? false;
	}
	function canToggleOnClick() {
		if (!options.openOnHover?.()) return true;
		return canHover();
	}
	function clearBlurGuard() {
		ignoreNextBlurClose = false;
		if (blurGuardTimeout !== null) {
			clearTimeout(blurGuardTimeout);
			blurGuardTimeout = null;
		}
	}
	function armBlurGuard() {
		ignoreNextBlurClose = true;
		if (blurGuardTimeout !== null) clearTimeout(blurGuardTimeout);
		blurGuardTimeout = setTimeout(clearBlurGuard, 500);
	}
	function consumeBlurGuard() {
		if (!ignoreNextBlurClose) return false;
		clearBlurGuard();
		return true;
	}
	function isTriggerDisabled() {
		if (!triggerEl) return false;
		if (triggerEl.hasAttribute("disabled")) return true;
		return triggerEl.getAttribute("aria-disabled") === "true";
	}
	/**
	* The transition handler manages animation lifecycle via `createState`:
	*
	* **Open:** `transition.open()` patches `{ active: true, status: 'starting' }`.
	* After a double-RAF it patches `{ status: 'idle' }`, then waits for the
	* resulting element animations before the promise resolves.
	* Frameworks render `data-starting-style` / `data-ending-style` via
	* `getPopupAttrs(state)` — no imperative DOM mutation needed.
	*
	* **Close:** `transition.close(el)` patches `{ status: 'ending' }` (keeping
	* `active: true` so the element stays mounted). After a double-RAF it waits
	* for `getAnimations()` to settle, then patches `{ active: false, status: 'idle' }`.
	*
	* `onOpenChange` fires immediately (before animations).
	* `onOpenChangeComplete` fires after animations finish.
	*/
	function commitOpen() {
		const opening = layer.open(() => popupEl);
		if (!opening) return;
		options.group?.()?.open(groupMember);
		opening.then(() => {
			if (layer.signal.aborted || !state.current.active || state.current.status !== "idle") return;
			options.onOpenChangeComplete?.(true);
		});
	}
	function commitClose() {
		const closing = layer.close(popupEl);
		if (!closing) return;
		options.group?.()?.close(groupMember);
		closing.then(() => {
			if (layer.signal.aborted || state.current.active) return;
			tryHidePopover(popupEl);
			options.onOpenChangeComplete?.(false);
		});
	}
	function applyOpen(reason, event) {
		if (layer.signal.aborted) return;
		const { active, status } = state.current;
		if (active && status !== "ending") return;
		onOpenChange(true, event ? {
			reason,
			event
		} : { reason });
		if (!options.deferOpenChanges) commitOpen();
	}
	function applyClose(reason, event) {
		if (layer.signal.aborted) return;
		const { active, status } = state.current;
		if (!active || status === "ending") return;
		onOpenChange(false, event ? {
			reason,
			event
		} : { reason });
		if (!options.deferOpenChanges) commitClose();
	}
	function open(reason = "click") {
		applyOpen(reason);
	}
	function close(reason = "click") {
		clearHoverTimeout();
		applyClose(reason);
	}
	function syncOpen(open) {
		if (!options.deferOpenChanges) return;
		if (open) commitOpen();
		else commitClose();
	}
	function handleDocumentPointerdown(event) {
		if (!closeOnOutsideClick() || !state.current.active) return;
		const path = event.composedPath();
		if (triggerEl && path.includes(triggerEl) || popupEl && path.includes(popupEl)) {
			armBlurGuard();
			return;
		}
		clearBlurGuard();
		applyClose("outside-click", event);
	}
	layer.signal.addEventListener("abort", () => {
		options.group?.()?.close(groupMember);
		clearHoverTimeout();
		clearBlurGuard();
		capturedPointers.clear();
		triggerEl = null;
		popupEl = null;
	});
	const triggerProps = {
		onClick(event) {
			if (!canToggleOnClick()) return;
			if (isTriggerDisabled()) return;
			if (state.current.active && state.current.status !== "ending") applyClose("click", event);
			else applyOpen("click", event);
		},
		onPointerEnter(_event) {
			if (!options.openOnHover?.()) return;
			if (!canHover()) return;
			clearHoverTimeout();
			if (state.current.active) return;
			const delay = options.delay?.() ?? 300;
			hoverTimeout = setTimeout(() => applyOpen("hover"), delay);
		},
		onPointerLeave(_event) {
			if (!options.openOnHover?.()) return;
			if (!canHover()) return;
			clearHoverTimeout();
			if (!state.current.active) return;
			const closeDelay = options.closeDelay?.() ?? 0;
			hoverTimeout = setTimeout(() => applyClose("hover"), closeDelay);
		},
		onFocusIn(_event) {
			if (options.openOnHover?.()) {
				if (!canOpenOnFocus()) return;
				applyOpen("focus");
			}
		},
		onFocusOut(event) {
			const relatedTarget = event.relatedTarget;
			if (relatedTarget && (triggerEl?.contains(relatedTarget) || popupEl?.contains(relatedTarget))) return;
			if (options.openOnHover?.()) applyClose("blur");
		}
	};
	const popupProps = {
		onPointerEnter(_event) {
			if (!options.openOnHover?.()) return;
			clearHoverTimeout();
		},
		onPointerLeave(_event) {
			if (!options.openOnHover?.()) return;
			if (capturedPointers.size > 0) return;
			clearHoverTimeout();
			if (!state.current.active) return;
			const closeDelay = options.closeDelay?.() ?? 0;
			hoverTimeout = setTimeout(() => applyClose("hover"), closeDelay);
		},
		onGotPointerCapture(event) {
			capturedPointers.add(event.pointerId);
		},
		onLostPointerCapture(event) {
			capturedPointers.delete(event.pointerId);
		},
		onFocusOut(event) {
			const relatedTarget = event.relatedTarget;
			if (relatedTarget && (triggerEl?.contains(relatedTarget) || popupEl?.contains(relatedTarget))) return;
			if (consumeBlurGuard()) return;
			if (relatedTarget !== null) {
				applyClose("blur");
				return;
			}
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					if (!state.current.active || state.current.status === "ending" || state.current.status === "starting") return;
					const active = document.activeElement;
					if (active && (triggerEl?.contains(active) || popupEl?.contains(active))) return;
					applyClose("blur");
				});
			});
		}
	};
	function setTriggerElement(el) {
		triggerEl = el;
	}
	function setPopupElement(el) {
		if (!el && popupEl && state.current.active) tryHidePopover(popupEl);
		popupEl = el;
		if (el) {
			if (state.current.active) tryShowPopover(el);
		}
	}
	return {
		input: state,
		triggerProps,
		popupProps,
		get triggerElement() {
			return triggerEl;
		},
		setTriggerElement,
		setPopupElement,
		open,
		close,
		syncOpen,
		destroy: layer.destroy
	};
}

//#endregion
//#region ../core/dist/default/core/ui/menu/menu-css-vars.js
/** CSS custom property names for menu layout and positioning. */
const MenuCSSVars = {
	/** Width of the active menu panel (px). */
	width: "--media-menu-width",
	/** Height of the active menu panel (px). */
	height: "--media-menu-height",
	/** Viewport-constrained max width for the menu (px). */
	availableWidth: "--media-menu-available-width",
	/** Viewport-constrained max height for the menu (px). */
	availableHeight: "--media-menu-available-height"
};

//#endregion
//#region ../core/dist/default/core/ui/menu/menu-item-data-attrs.js
/**
* Data attributes set on all navigable menu item elements.
*
* @parts item, radio-item, checkbox-item, trigger
*/
const MenuItemDataAttrs = {
	/**
	* Present on all navigable item types: Item, RadioItem, CheckboxItem, and
	* the Trigger when acting as a submenu trigger inside a parent menu.
	* Use `[data-item]` as a shared selector to target all item types at once.
	*/
	item: "data-item",
	/** Present when the item has keyboard or pointer focus (via roving tabindex). */
	highlighted: "data-highlighted"
};

//#endregion
//#region ../core/dist/default/core/ui/popover/popover-css-vars.js
const PopoverCSSVars = {
	/** Distance between the popup and the trigger along the side axis. */
	sideOffset: "--media-popover-side-offset",
	/** Distance between the popup and the trigger along the alignment axis. */
	alignOffset: "--media-popover-align-offset",
	/** Minimum distance between the popup and the positioning boundary. */
	boundaryOffset: "--media-popover-boundary-offset",
	/** The anchor element's width. */
	anchorWidth: "--media-popover-anchor-width",
	/** The anchor element's height. */
	anchorHeight: "--media-popover-anchor-height",
	/** Available width between the trigger and the boundary edge. */
	availableWidth: "--media-popover-available-width",
	/** Available height between the trigger and the boundary edge. */
	availableHeight: "--media-popover-available-height"
};

//#endregion
//#region ../core/dist/default/dom/ui/menu/create-menu.js
function isMenuNavigationKey(event) {
	const { key } = event;
	return key === "ArrowDown" || key === "ArrowUp" || key === "ArrowLeft" || key === "ArrowRight" || key === "Home" || key === "End" || key === "Enter" || key === " " || key === "Escape" || key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey;
}
function getRootPositionOptions(side, align) {
	if (!side || !align) return null;
	return {
		side,
		align
	};
}
/** Uses Popover offset inputs while publishing Menu-owned available-size outputs. */
const MenuPositioningCSSVars = {
	...PopoverCSSVars,
	availableWidth: MenuCSSVars.availableWidth,
	availableHeight: MenuCSSVars.availableHeight
};
function completeMenuItemSelection(menu) {
	menu.close();
}
function createMenu(options) {
	const items = [];
	let highlightedItem = null;
	let triggerElement = null;
	let contentElement = null;
	const submenus = /* @__PURE__ */ new Set();
	let typeaheadBuffer = "";
	let typeaheadTimer = null;
	let openRafId = 0;
	let lastCloseReason = null;
	function isItemHidden(item) {
		return Boolean(item.hidden || item.hasAttribute("data-hidden") || item.getAttribute("aria-hidden") === "true");
	}
	function getNavigableItems() {
		return items.filter((item) => !isItemHidden(item));
	}
	function getAdjacentNavigableItem(direction) {
		if (items.length === 0) return null;
		const currentIndex = highlightedItem ? items.indexOf(highlightedItem) : direction === 1 ? -1 : 0;
		for (let offset = 1; offset <= items.length; offset++) {
			const candidate = items[(currentIndex + direction * offset + items.length) % items.length];
			if (candidate && !isItemHidden(candidate)) return candidate;
		}
		return null;
	}
	function highlight(element, highlightOptions) {
		if (element && isItemHidden(element)) {
			if (element === highlightedItem) highlight(getAdjacentNavigableItem(1), highlightOptions);
			return;
		}
		if (highlightedItem === element) return;
		if (highlightedItem) {
			highlightedItem.tabIndex = -1;
			highlightedItem.removeAttribute(MenuItemDataAttrs.highlighted);
		}
		highlightedItem = element;
		if (element) {
			element.tabIndex = 0;
			element.setAttribute(MenuItemDataAttrs.highlighted, "");
			if (highlightOptions?.focus !== false) if (highlightOptions?.preventScroll) element.focus({ preventScroll: true });
			else element.focus();
		}
		options.onHighlightChange?.(element);
	}
	function clearHighlight() {
		if (highlightedItem) {
			highlightedItem.tabIndex = -1;
			highlightedItem.removeAttribute(MenuItemDataAttrs.highlighted);
			highlightedItem = null;
			options.onHighlightChange?.(null);
		}
	}
	function highlightFirstItem(options) {
		highlight(getNavigableItems()[0] ?? null, options);
	}
	function getInitialHighlightItem() {
		const navigableItems = getNavigableItems();
		return navigableItems.find((item) => item.matches("[role=\"menuitemradio\"][aria-checked=\"true\"], [aria-selected=\"true\"]")) ?? navigableItems[0] ?? null;
	}
	function clearTypeahead() {
		if (typeaheadTimer !== null) {
			clearTimeout(typeaheadTimer);
			typeaheadTimer = null;
		}
		typeaheadBuffer = "";
	}
	function scheduleInitialHighlight() {
		cancelAnimationFrame(openRafId);
		openRafId = requestAnimationFrame(() => {
			openRafId = 0;
			if (!popover.input.current.active || popover.input.current.status === "ending" || highlightedItem) return;
			highlight(getInitialHighlightItem());
		});
	}
	function handleTypeahead(char) {
		typeaheadBuffer = typeaheadBuffer.length === 1 && typeaheadBuffer.toLowerCase() === char.toLowerCase() ? char : typeaheadBuffer + char;
		if (typeaheadTimer !== null) clearTimeout(typeaheadTimer);
		typeaheadTimer = setTimeout(clearTypeahead, 500);
		const navigableItems = getNavigableItems();
		const searchStart = (highlightedItem ? navigableItems.indexOf(highlightedItem) : -1) + 1;
		const candidates = [...navigableItems.slice(searchStart), ...navigableItems.slice(0, searchStart)];
		const needle = typeaheadBuffer.toLowerCase();
		const match = candidates.find((candidate) => {
			return (candidate.textContent?.trim().toLowerCase() ?? "").startsWith(needle);
		});
		if (match) highlight(match);
	}
	const popover = createPopover({
		transition: options.transition,
		deferOpenChanges: true,
		onOpenChange(open, details) {
			lastCloseReason = open ? null : details.reason;
			options.onOpenChange(open, details);
			if (open) scheduleInitialHighlight();
			else {
				clearHighlight();
				clearTypeahead();
			}
		},
		onOpenChangeComplete(open) {
			options.onOpenChangeComplete?.(open);
			if (!open && lastCloseReason !== "imperative-action" && lastCloseReason !== "group-open") triggerElement?.focus();
		},
		closeOnEscape: options.closeOnEscape,
		closeOnOutsideClick: options.closeOnOutsideClick,
		...options.group ? { group: options.group } : {}
	});
	const contentProps = {
		onFocusOut: popover.popupProps.onFocusOut,
		onKeyDown(event) {
			const { key } = event;
			const navigableItems = getNavigableItems();
			if (key !== "Escape" && isMenuNavigationKey(event) && !event.defaultPrevented) event.preventDefault();
			if (navigableItems.length === 0) return;
			switch (key) {
				case "ArrowDown":
					event.preventDefault();
					highlight(getAdjacentNavigableItem(1));
					break;
				case "ArrowUp":
					event.preventDefault();
					highlight(getAdjacentNavigableItem(-1));
					break;
				case "Home":
					event.preventDefault();
					highlight(navigableItems[0] ?? null);
					break;
				case "End":
					event.preventDefault();
					highlight(navigableItems[navigableItems.length - 1] ?? null);
					break;
				case "Enter":
				case " ":
					event.preventDefault();
					if (highlightedItem && navigableItems.includes(highlightedItem)) highlightedItem.click();
					break;
				default: if (key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) handleTypeahead(key);
			}
		}
	};
	function handleTriggerKeyDown(event) {
		const input = popover.input.current;
		if (!input.active || input.status === "ending") return;
		if (event.key === "Escape") return;
		if (!isMenuNavigationKey(event)) return;
		contentProps.onKeyDown(event);
		event.stopPropagation();
	}
	function setTriggerElement(element) {
		triggerElement = element;
		popover.setTriggerElement(element);
	}
	function setContentElement(element) {
		contentElement = element;
		popover.setPopupElement(element);
	}
	function compareItems(a, b) {
		if (a === b) return 0;
		const position = a.compareDocumentPosition(b);
		if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
		if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
		return 0;
	}
	function registerItem(element) {
		element.tabIndex = -1;
		element.setAttribute(MenuItemDataAttrs.item, "");
		items.push(element);
		items.sort(compareItems);
		if (popover.input.current.active && popover.input.current.status !== "ending" && !highlightedItem) scheduleInitialHighlight();
		return () => {
			const index = items.indexOf(element);
			if (index !== -1) items.splice(index, 1);
			if (highlightedItem === element) clearHighlight();
		};
	}
	function registerSubmenu(menu) {
		submenus.add(menu);
		return () => submenus.delete(menu);
	}
	function syncOpen(open) {
		if (!open) for (const submenu of submenus) submenu.close("imperative-action");
		popover.syncOpen(open);
	}
	function destroy() {
		cancelAnimationFrame(openRafId);
		openRafId = 0;
		clearTypeahead();
		submenus.clear();
		popover.destroy();
	}
	return {
		input: popover.input,
		triggerProps: {
			onClick: popover.triggerProps.onClick,
			onKeyDown: handleTriggerKeyDown
		},
		contentProps,
		get triggerElement() {
			return triggerElement;
		},
		get contentElement() {
			return contentElement;
		},
		setTriggerElement,
		setContentElement,
		registerItem,
		registerSubmenu,
		highlight,
		highlightFirstItem,
		open: popover.open,
		close: popover.close,
		syncOpen,
		destroy
	};
}

//#endregion
//#region ../core/dist/default/dom/ui/menu/menu-size.js
const MENU_SUBMENU_ATTR = "data-submenu";
const MENU_SUBMENU_EXPANDED_ATTR = "data-submenu-expanded";
const coveredStates = /* @__PURE__ */ new WeakMap();
const rootSizes = /* @__PURE__ */ new WeakMap();
function getActiveSubmenu(content) {
	return findElementChild(content, (child) => child instanceof HTMLElement && child.hasAttribute(MENU_SUBMENU_ATTR) && !child.hidden);
}
function getRootChildren(content) {
	return getElementChildren(content, (child) => child instanceof HTMLElement && !child.hasAttribute(MENU_SUBMENU_ATTR));
}
function setCovered(element, covered) {
	const previous = coveredStates.get(element);
	if (covered) {
		if (!previous) coveredStates.set(element, snapshotAttributes(element, ["aria-hidden", "inert"]));
		element.setAttribute("aria-hidden", "true");
		element.setAttribute("inert", "");
		return;
	}
	if (!previous) return;
	restoreAttributes(element, previous);
	coveredStates.delete(element);
}
function measureMenuElement(element, width) {
	return measureElement(element, {
		overflow: "both",
		styles: {
			insetInlineStart: "0px",
			insetInlineEnd: "auto",
			width: width === void 0 ? "max-content" : `${width}px`,
			height: "auto",
			minWidth: "0px",
			maxWidth: "none"
		}
	});
}
function getAvailableWidth(content) {
	return walkAncestors(content, (element) => {
		const width = readCSSLength(element, MenuCSSVars.availableWidth);
		return width !== null && width > 0 ? width : void 0;
	}) ?? null;
}
function constrainWidth(content, width) {
	const availableWidth = getAvailableWidth(content);
	return availableWidth === null ? width : Math.min(width, Math.max(0, availableWidth));
}
function getRootSize(content, children) {
	return measureElementChildren(content, {
		children,
		includePadding: true,
		maxWidth: getAvailableWidth(content),
		measure: measureMenuElement
	});
}
function getConstrainedElementSize(content, element) {
	const naturalSize = measureMenuElement(element);
	const width = constrainWidth(content, naturalSize.width);
	if (width >= naturalSize.width) return naturalSize;
	return {
		width,
		height: measureMenuElement(element, width).height
	};
}
function getCurrentSize(content) {
	const path = followElementPath(content, (current) => {
		const activeSubmenu = getActiveSubmenu(current);
		return activeSubmenu?.hasAttribute("data-ending-style") ? null : activeSubmenu;
	});
	const current = path[path.length - 1];
	const activeSubmenu = getActiveSubmenu(current);
	const rootChildren = getRootChildren(current);
	const measuredRootSize = getRootSize(current, rootChildren);
	const ownRootSize = current.hasAttribute(MENU_SUBMENU_ATTR) && rootChildren.length === 0 ? getConstrainedElementSize(current, current) : measuredRootSize;
	if (!activeSubmenu?.hasAttribute("data-ending-style")) {
		rootSizes.set(current, ownRootSize);
		return ownRootSize;
	}
	return rootSizes.get(current) ?? ownRootSize;
}
/** Synchronize menu size and accessibility to the active submenu, if any. */
function syncMenuSize(content) {
	if (!content) return;
	const activeSubmenu = getActiveSubmenu(content);
	const rootChildren = getRootChildren(content);
	const covered = activeSubmenu !== null;
	if (activeSubmenu) content.setAttribute(MENU_SUBMENU_EXPANDED_ATTR, activeSubmenu.hasAttribute("data-ending-style") ? "false" : "true");
	else content.removeAttribute(MENU_SUBMENU_EXPANDED_ATTR);
	for (const child of rootChildren) setCovered(child, covered);
	const size = getCurrentSize(content);
	content.style.setProperty(MenuCSSVars.width, `${Math.ceil(size.width)}px`);
	content.style.setProperty(MenuCSSVars.height, `${Math.ceil(size.height)}px`);
}
/** Synchronize a menu and each direct menu-content ancestor. */
function syncMenuSizeChain(content) {
	let current = content;
	while (current) {
		syncMenuSize(current);
		const parent = current.parentElement;
		current = parent?.getAttribute("role") === "menu" ? parent : null;
	}
}
/** Re-measure when the active submenu or ordinary root content changes size. */
function observeMenuSize(content, onResize) {
	return observeElements({
		root: content,
		getElements: () => {
			const activeSubmenu = getActiveSubmenu(content);
			return activeSubmenu && !activeSubmenu.hasAttribute("data-ending-style") ? [activeSubmenu] : getRootChildren(content);
		},
		mutations: { childList: true },
		onChange: onResize
	});
}

//#endregion
//#region ../core/dist/default/dom/ui/popover/popup-group.js
function createPopupGroup() {
	let current = null;
	const listeners = /* @__PURE__ */ new Set();
	function notify() {
		for (const listener of listeners) listener();
	}
	return {
		open(member) {
			if (current === member) return;
			const previous = current;
			current = member;
			previous?.close("group-open");
			notify();
		},
		close(member) {
			if (current !== member) return;
			current = null;
			notify();
		},
		isOpenFor(trigger) {
			return trigger !== null && current?.triggerElement === trigger;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}
	};
}

//#endregion
//#region ../core/dist/default/dom/utils/event.js
function isEventWithinElement(event, element) {
	if (!element) return false;
	if (isFunction(event.composedPath)) return event.composedPath().includes(element);
	const target = event.target;
	return target instanceof Node && element.contains(target);
}

//#endregion
//#region ../core/dist/default/dom/utils/layout.js
function createDOMRect(left, top, width, height) {
	const right = left + width;
	const bottom = top + height;
	return {
		x: left,
		y: top,
		width,
		height,
		top,
		right,
		bottom,
		left,
		toJSON() {
			return {
				x: left,
				y: top,
				width,
				height,
				top,
				right,
				bottom,
				left
			};
		}
	};
}
function intersectDOMRects(firstRect, secondRect) {
	const left = Math.max(firstRect.left, secondRect.left);
	const top = Math.max(firstRect.top, secondRect.top);
	const right = Math.min(firstRect.right, secondRect.right);
	const bottom = Math.min(firstRect.bottom, secondRect.bottom);
	return createDOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
}
function getPositioningBoundaryRect(boundaryElement) {
	const viewportRect = document.documentElement.getBoundingClientRect();
	return boundaryElement ? intersectDOMRects(viewportRect, boundaryElement.getBoundingClientRect()) : viewportRect;
}
function resolvePositioningBoundary(boundary, options = {}) {
	if (!boundary) return null;
	if (!isString(boundary)) return boundary;
	if (boundary === "viewport") return null;
	if (boundary === "container") return options.container ?? null;
	try {
		return (options.root ?? document).querySelector(boundary);
	} catch {
		return null;
	}
}

//#endregion
//#region ../utils/dist/number/number.js
/** Clamp a value between min and max (inclusive). */
function clamp(value, min, max) {
	return Math.max(min, Math.min(max, value));
}
/**
* Convert a value within a range to a clamped percentage (0–100).
*
* @param value - Value to convert.
* @param min - Start of the range.
* @param max - End of the range.
*/
function toPercent(value, min, max) {
	const range = max - min;
	if (!Number.isFinite(range) || range <= 0) return 0;
	return clamp((value - min) / range * 100, 0, 100);
}
/** Snap a value to the nearest step, offset from min. */
function roundToStep(value, step, min) {
	const nearest = Math.round((value - min) / step) * step + min;
	const dot = `${step}`.indexOf(".");
	return dot === -1 ? nearest : Number(nearest.toFixed(`${step}`.length - dot - 1));
}

//#endregion
//#region ../core/dist/default/dom/ui/popover/popover-positioning.js
const ZERO_OFFSETS = {
	sideOffset: 0,
	alignOffset: 0,
	boundaryOffset: 0
};
const OPPOSITE_SIDE = {
	top: "bottom",
	bottom: "top",
	left: "right",
	right: "left"
};
function formatPixels(value) {
	return `${clamp(value, 0, Infinity)}px`;
}
function shiftCrossAxis(value, boundaryStart, boundaryEnd, size) {
	const max = boundaryEnd - size;
	return max < boundaryStart ? boundaryStart : clamp(value, boundaryStart, max);
}
function getAnchorCrossAxisShift(start, end, size, boundaryStart, boundaryEnd, align, alignOffset, boundaryOffset) {
	const base = align === "start" ? start + alignOffset : align === "end" ? end + alignOffset : start + size / 2 + alignOffset;
	const desiredTranslate = align === "start" ? "0px" : align === "end" ? "-100%" : "-50%";
	return {
		base: `${base}px`,
		translate: `clamp(${boundaryStart + boundaryOffset - base}px, ${desiredTranslate}, calc(${boundaryEnd - boundaryOffset - base}px - 100%))`
	};
}
/**
* Get positioning styles for the popup element.
*
* When the browser supports CSS Anchor Positioning, returns native CSS properties
* that reference the provided CSS var names for side/align offsets — no JS offset
* values needed.
*
* When rects are provided and anchor positioning is unsupported, falls back to
* manual JS-computed positioning. The caller must resolve offset CSS vars via
* `getComputedStyle` and pass them as `offsets`.
*
* Returns camelCase keys for standard CSS properties and `--*` keys for
* custom properties — compatible with both React's `style` prop and
* `applyStyles()` from `@videojs/utils/dom`.
*/
function getAnchorPositionStyle(anchorName, opts, triggerRect, popupRect, boundaryRect, offsets, cssVars = PopoverCSSVars) {
	if (supportsAnchorPositioning()) return {
		...getAnchorPositionCSS(anchorName, opts, cssVars, triggerRect, boundaryRect, offsets),
		...triggerRect && boundaryRect ? getPositioningCSSVars(triggerRect, boundaryRect, opts, offsets, cssVars) : {}
	};
	if (triggerRect && popupRect) {
		const resolved = offsets ?? ZERO_OFFSETS;
		return {
			position: "fixed",
			margin: "0",
			...getManualPositionStyle(triggerRect, popupRect, opts, resolved, boundaryRect),
			...boundaryRect ? getPositioningCSSVars(triggerRect, boundaryRect, opts, resolved, cssVars) : {}
		};
	}
	return {};
}
function getAnchorPositionCSS(anchorName, opts, cssVars = PopoverCSSVars, triggerRect, boundaryRect, offsets = ZERO_OFFSETS) {
	const SIDE_OFFSET_VAR = `var(${cssVars.sideOffset}, 0px)`;
	const ALIGN_OFFSET_VAR = `var(${cssVars.alignOffset}, 0px)`;
	const { side, align } = opts;
	const boundaryOffset = offsets.boundaryOffset ?? 0;
	const style = {
		positionAnchor: `--${anchorName}`,
		position: "fixed",
		inset: "auto",
		margin: "0",
		justifySelf: "normal",
		alignSelf: "normal",
		marginInlineStart: "0",
		marginBlockStart: "0",
		translate: "none"
	};
	const insetProp = OPPOSITE_SIDE[side];
	if (side === "top" || side === "bottom") {
		style[insetProp] = `calc(anchor(${side}) + ${SIDE_OFFSET_VAR})`;
		if (triggerRect && boundaryRect) {
			const { base, translate } = getAnchorCrossAxisShift(triggerRect.left, triggerRect.right, triggerRect.width, boundaryRect.left, boundaryRect.right, align, offsets.alignOffset, boundaryOffset);
			style.left = base;
			style.translate = `${translate} 0`;
			return style;
		}
		if (align === "start") style.left = `calc(anchor(left) + ${ALIGN_OFFSET_VAR})`;
		else if (align === "end") style.right = `calc(anchor(right) + ${ALIGN_OFFSET_VAR})`;
		else {
			style.justifySelf = "anchor-center";
			style.marginInlineStart = ALIGN_OFFSET_VAR;
		}
	} else {
		style[insetProp] = `calc(anchor(${side}) + ${SIDE_OFFSET_VAR})`;
		if (triggerRect && boundaryRect) {
			const { base, translate } = getAnchorCrossAxisShift(triggerRect.top, triggerRect.bottom, triggerRect.height, boundaryRect.top, boundaryRect.bottom, align, offsets.alignOffset, boundaryOffset);
			style.top = base;
			style.translate = `0 ${translate}`;
			return style;
		}
		if (align === "start") style.top = `calc(anchor(top) + ${ALIGN_OFFSET_VAR})`;
		else if (align === "end") style.bottom = `calc(anchor(bottom) + ${ALIGN_OFFSET_VAR})`;
		else {
			style.alignSelf = "anchor-center";
			style.marginBlockStart = ALIGN_OFFSET_VAR;
		}
	}
	return style;
}
/**
* Compute CSS variables for sizing constraints relative to the anchor/boundary.
*
* Accepts a `cssVars` map so the same logic works for both popover
* (`--media-popover-*`) and tooltip (`--media-tooltip-*`) namespaces.
*/
function getPositioningCSSVars(triggerRect, boundaryRect, opts, offsets = ZERO_OFFSETS, cssVars = PopoverCSSVars) {
	const vars = {};
	const { side } = opts;
	const boundaryOffset = offsets.boundaryOffset ?? 0;
	const boundaryStartX = boundaryRect.left + boundaryOffset;
	const boundaryEndX = boundaryRect.right - boundaryOffset;
	const boundaryStartY = boundaryRect.top + boundaryOffset;
	const boundaryEndY = boundaryRect.bottom - boundaryOffset;
	vars[cssVars.anchorWidth] = `${triggerRect.width}px`;
	vars[cssVars.anchorHeight] = `${triggerRect.height}px`;
	if (side === "top" || side === "bottom") {
		const sideSpace = side === "top" ? triggerRect.top - boundaryStartY : boundaryEndY - triggerRect.bottom;
		vars[cssVars.availableHeight] = formatPixels(sideSpace - offsets.sideOffset);
		vars[cssVars.availableWidth] = formatPixels(boundaryEndX - boundaryStartX);
	} else {
		const sideSpace = side === "left" ? triggerRect.left - boundaryStartX : boundaryEndX - triggerRect.right;
		vars[cssVars.availableWidth] = formatPixels(sideSpace - offsets.sideOffset);
		vars[cssVars.availableHeight] = formatPixels(boundaryEndY - boundaryStartY);
	}
	return vars;
}
/**
* Compute manual positioning when CSS Anchor Positioning is not supported.
*
* Returns inline `top`/`left` styles in **viewport coordinates** for use
* with `position: fixed` (the popup is in the top layer). All rects from
* `getBoundingClientRect()` are already viewport-relative.
*
* Offsets are resolved by the caller from CSS custom properties via
* `getComputedStyle()` and passed as `offsets`.
*/
function getManualPositionStyle(triggerRect, popupRect, opts, offsets = {
	sideOffset: 0,
	alignOffset: 0
}, boundaryRect) {
	const { side, align } = opts;
	const { sideOffset, alignOffset } = offsets;
	let top = 0;
	let bottom;
	let left = 0;
	let right;
	if (side === "top") bottom = `calc(100% - ${triggerRect.top}px + ${sideOffset}px)`;
	else if (side === "bottom") top = triggerRect.bottom + sideOffset;
	else if (side === "left") right = `calc(100% - ${triggerRect.left}px + ${sideOffset}px)`;
	else left = triggerRect.right + sideOffset;
	if (side === "top" || side === "bottom") if (align === "start") left = triggerRect.left + alignOffset;
	else if (align === "end") left = triggerRect.right - popupRect.width + alignOffset;
	else left = triggerRect.left + (triggerRect.width - popupRect.width) / 2 + alignOffset;
	else if (align === "start") top = triggerRect.top + alignOffset;
	else if (align === "end") top = triggerRect.bottom - popupRect.height + alignOffset;
	else top = triggerRect.top + (triggerRect.height - popupRect.height) / 2 + alignOffset;
	if (boundaryRect) {
		const boundaryOffset = offsets.boundaryOffset ?? 0;
		if (side === "top" || side === "bottom") left = shiftCrossAxis(left, boundaryRect.left + boundaryOffset, boundaryRect.right - boundaryOffset, popupRect.width);
		else top = shiftCrossAxis(top, boundaryRect.top + boundaryOffset, boundaryRect.bottom - boundaryOffset, popupRect.height);
	}
	return {
		top: side === "top" ? "auto" : `${top}px`,
		bottom: bottom ?? "auto",
		left: side === "left" ? "auto" : `${left}px`,
		right: right ?? "auto"
	};
}
/**
* Read positioning offset CSS custom properties from the
* popup element's computed style, returning numeric pixel values.
*/
function resolveOffsets(el, cssVars = PopoverCSSVars) {
	const computed = getComputedStyle(el);
	return {
		sideOffset: resolveCSSLength(el, computed.getPropertyValue(cssVars.sideOffset)),
		alignOffset: resolveCSSLength(el, computed.getPropertyValue(cssVars.alignOffset)),
		boundaryOffset: resolveCSSLength(el, computed.getPropertyValue(cssVars.boundaryOffset))
	};
}
/**
* Measure the popup's layout box for positioning.
*
* `getBoundingClientRect()` includes active transforms, which causes the
* fallback position to drift while opening/closing animations scale the popup.
* Using layout dimensions preserves the untransformed size, while the
* side-axis scroll dimension includes content clipped by size constraints.
*/
function getPopupPositionRect(el, side) {
	const rect = el.getBoundingClientRect();
	const size = getElementSize(el, {
		box: "layout",
		overflow: side === "left" || side === "right" ? "width" : "height"
	});
	return createDOMRect(rect.left, rect.top, size.width, size.height);
}

//#endregion
//#region ../core/dist/default/dom/ui/popover/popup-positioner.js
const POPUP_STYLE_PROPS = [
	"position",
	"inset",
	"margin",
	"margin-top",
	"margin-right",
	"margin-bottom",
	"margin-left",
	"justify-self",
	"align-self",
	"margin-inline-start",
	"margin-block-start",
	"translate",
	"top",
	"right",
	"bottom",
	"left"
];
/** Positions a popup and tracks layout changes while it is active. */
var PopupPositioner = class {
	#options = null;
	#boundaryElement = null;
	#abort = null;
	#stopObservingResize = null;
	#triggerAnchorName = null;
	#triggerAnchorAdded = false;
	#popupAnchor = null;
	#popupStyles = null;
	#reposition = rafThrottle(() => this.#position());
	sync(options) {
		const { anchorName, position, trigger, popup, boundary, container, cssVars = PopoverCSSVars } = options;
		if (!position || !trigger || !popup) {
			this.cleanup();
			return;
		}
		const boundaryElement = resolvePositioningBoundary(boundary, {
			container: container ?? null,
			root: popup.getRootNode()
		});
		const previous = this.#options;
		if (!previous || previous.anchorName !== anchorName || previous.trigger !== trigger || previous.popup !== popup || (previous.cssVars ?? PopoverCSSVars) !== cssVars || this.#boundaryElement !== boundaryElement) {
			if (previous?.popup) this.#restorePopupStyles(previous.popup);
			this.#stopTracking();
			this.#options = {
				...options,
				cssVars
			};
			this.#boundaryElement = boundaryElement;
			this.#startTracking();
		} else this.#options = {
			...options,
			cssVars
		};
		this.#position();
	}
	cleanup() {
		if (!this.#options) return;
		if (this.#options.popup) this.#restorePopupStyles(this.#options.popup);
		this.#stopTracking();
		this.#options = null;
		this.#boundaryElement = null;
	}
	#startTracking() {
		const options = this.#options;
		if (!options?.trigger || !options.popup) return;
		this.#applyAnchorStyles(options.trigger, options.popup, options.anchorName);
		this.#abort = new AbortController();
		const { signal } = this.#abort;
		window.addEventListener("scroll", this.#schedule, {
			capture: true,
			passive: true,
			signal
		});
		window.addEventListener("resize", this.#schedule, { signal });
		const resizeTargets = [options.trigger, options.popup];
		if (this.#boundaryElement) resizeTargets.push(this.#boundaryElement);
		this.#stopObservingResize = observeResize(resizeTargets, () => this.#schedule());
	}
	#stopTracking() {
		this.#abort?.abort();
		this.#abort = null;
		this.#stopObservingResize?.();
		this.#stopObservingResize = null;
		this.#reposition.cancel();
		this.#restoreAnchorStyles();
	}
	#schedule = (event) => {
		const popup = this.#options?.popup;
		if (!popup || event && isEventWithinElement(event, popup)) return;
		this.#reposition();
	};
	#position() {
		const options = this.#options;
		if (!options?.position || !options.trigger || !options.popup) return;
		const triggerRect = options.trigger.getBoundingClientRect();
		const boundaryRect = getPositioningBoundaryRect(this.#boundaryElement);
		const offsets = resolveOffsets(options.popup, options.cssVars);
		const preferredPosition = options.position;
		const anchorSupported = supportsAnchorPositioning();
		const getPosition = (popupRect) => {
			const side = getPositionedSide(triggerRect, popupRect, boundaryRect, preferredPosition, offsets);
			const { positionAnchor: _, ...style } = getAnchorPositionStyle(options.anchorName, {
				...preferredPosition,
				side
			}, triggerRect, anchorSupported ? void 0 : popupRect, boundaryRect, offsets, options.cssVars);
			return {
				popupRect,
				side,
				style
			};
		};
		const position = getPosition(getPopupPositionRect(options.popup, preferredPosition.side));
		this.#capturePopupStyles(options.popup, options.cssVars ?? PopoverCSSVars);
		applyStyles(options.popup, position.style);
		options.onSideChange?.(position.side);
		if (anchorSupported || !options.onSideChange) return;
		const popupRect = getPopupPositionRect(options.popup, preferredPosition.side);
		if (popupRect.width === position.popupRect.width && popupRect.height === position.popupRect.height) return;
		const nextPosition = getPosition(popupRect);
		applyStyles(options.popup, nextPosition.style);
		if (nextPosition.side !== position.side) options.onSideChange(nextPosition.side);
	}
	#capturePopupStyles(popup, cssVars) {
		if (this.#popupStyles) return;
		const props = [
			...POPUP_STYLE_PROPS,
			cssVars.anchorWidth,
			cssVars.anchorHeight,
			cssVars.availableWidth,
			cssVars.availableHeight
		];
		this.#popupStyles = snapshotInlineStyles(popup, props);
	}
	#restorePopupStyles(popup) {
		if (!this.#popupStyles) return;
		restoreInlineStyles(popup, this.#popupStyles);
		this.#popupStyles = null;
	}
	#applyAnchorStyles(trigger, popup, anchorName) {
		if (!supportsAnchorPositioning()) return;
		const generatedName = `--${anchorName}`;
		const triggerAnchor = this.#readStyle(trigger, "anchor-name");
		this.#popupAnchor = this.#readStyle(popup, "position-anchor");
		const names = getAnchorNames(trigger);
		this.#triggerAnchorName = generatedName;
		this.#triggerAnchorAdded = !names.includes(generatedName);
		if (this.#triggerAnchorAdded) names.push(generatedName);
		trigger.style.setProperty("anchor-name", names.join(", "), triggerAnchor.priority);
		popup.style.setProperty("position-anchor", generatedName);
	}
	#restoreAnchorStyles() {
		const options = this.#options;
		if (!options?.trigger || !options.popup) return;
		if (this.#triggerAnchorName && this.#triggerAnchorAdded) {
			const current = this.#readStyle(options.trigger, "anchor-name");
			const names = getAnchorNames(options.trigger).filter((name) => name !== this.#triggerAnchorName);
			this.#writeStyle(options.trigger, "anchor-name", {
				value: names.join(", "),
				priority: current.priority
			});
		}
		if (this.#popupAnchor) this.#writeStyle(options.popup, "position-anchor", this.#popupAnchor);
		this.#triggerAnchorName = null;
		this.#triggerAnchorAdded = false;
		this.#popupAnchor = null;
	}
	#readStyle(element, prop) {
		const name = prop.startsWith("--") ? prop : kebabCase(prop);
		return {
			value: element.style.getPropertyValue(name),
			priority: element.style.getPropertyPriority(name)
		};
	}
	#writeStyle(element, prop, style) {
		const name = prop.startsWith("--") ? prop : kebabCase(prop);
		if (style.value) element.style.setProperty(name, style.value, style.priority);
		else element.style.removeProperty(name);
	}
};

//#endregion
//#region ../core/dist/default/dom/utils/pointer.js
/** Convert a pointer event position to a 0–100 percent along an element's rect. */
function getPercentFromPointerEvent(event, rect, orientation, isRTL) {
	let ratio;
	if (orientation === "vertical") ratio = 1 - (event.clientY - rect.top) / rect.height;
	else if (isRTL) ratio = (rect.right - event.clientX) / rect.width;
	else ratio = (event.clientX - rect.left) / rect.width;
	if (!Number.isFinite(ratio)) return 0;
	return clamp(ratio * 100, 0, 100);
}

//#endregion
//#region ../core/dist/default/dom/ui/slider.js
function createSlider(options) {
	const input = createState({
		pointerPercent: 0,
		dragPercent: 0,
		dragging: false,
		pointing: false,
		focused: false
	});
	const abort = new AbortController();
	const changeThrottleMs = options.changeThrottle ?? 0;
	let isDragging = false, cachedRTL = false, cachedRect = null, capturedPointerId = null, lastDragPercent = 0, committedOnRelease = false;
	const throttledChange = changeThrottleMs > 0 ? throttle((percent) => options.onValueChange?.(percent), changeThrottleMs, { leading: true }) : null;
	/** Fire `onValueChange` — throttled during drag when `changeThrottle > 0`. */
	function fireChange(percent, duringDrag) {
		if (duringDrag && throttledChange) throttledChange(percent);
		else options.onValueChange?.(percent);
	}
	function releaseCapture() {
		if (isNull(capturedPointerId)) return;
		const id = capturedPointerId;
		capturedPointerId = null;
		try {
			options.getElement().releasePointerCapture(id);
		} catch {}
	}
	function endDrag() {
		if (!isDragging) input.patch({ pointing: false });
		else {
			if (!committedOnRelease) options.onValueCommit?.(lastDragPercent);
			isDragging = false;
			input.patch({
				dragging: false,
				pointing: false
			});
			options.onDragEnd?.();
		}
		committedOnRelease = false;
		cleanup();
	}
	function cleanup() {
		throttledChange?.cancel();
		capturedPointerId = null;
		cachedRect = null;
	}
	const rootProps = {
		onPointerDown(event) {
			if (options.isDisabled()) return;
			event.stopPropagation();
			event.preventDefault();
			const el = options.getElement();
			cachedRect = el.getBoundingClientRect();
			cachedRTL = options.isRTL();
			committedOnRelease = false;
			releaseCapture();
			capturedPointerId = event.pointerId;
			el.setPointerCapture(event.pointerId);
			const percent = getPercentFromPointerEvent(event, cachedRect, options.getOrientation(), cachedRTL);
			isDragging = true;
			lastDragPercent = percent;
			input.patch({
				pointing: true,
				dragging: true,
				pointerPercent: percent,
				dragPercent: percent
			});
			options.onDragStart?.();
			options.onValueChange?.(percent);
			options.getThumbElement?.()?.focus({
				preventScroll: true,
				focusVisible: false
			});
		},
		onPointerMove(event) {
			if (options.isDisabled()) return;
			if (!isNull(capturedPointerId)) {
				if (event.pointerType !== "touch" && event.buttons === 0) {
					endDrag();
					return;
				}
				const percent = getPercentFromPointerEvent(event, cachedRect, options.getOrientation(), cachedRTL);
				lastDragPercent = percent;
				input.patch({
					dragPercent: percent,
					pointerPercent: percent
				});
				fireChange(percent, true);
				return;
			}
			const percent = getPercentFromPointerEvent(event, options.getElement().getBoundingClientRect(), options.getOrientation(), options.isRTL());
			input.patch({
				pointing: true,
				pointerPercent: percent
			});
		},
		onPointerUp(event) {
			if (options.isDisabled()) return;
			event.stopPropagation();
			if (isNull(capturedPointerId)) return;
			const percent = getPercentFromPointerEvent(event, cachedRect, options.getOrientation(), cachedRTL);
			throttledChange?.cancel();
			options.onValueChange?.(percent);
			options.onValueCommit?.(percent);
			committedOnRelease = true;
		},
		onPointerLeave() {
			if (!isNull(capturedPointerId)) return;
			input.patch({ pointing: false });
		},
		onLostPointerCapture() {
			endDrag();
		}
	};
	const thumbProps = {
		onKeyDown(event) {
			if (options.isDisabled()) {
				if (event.key !== "Tab") event.preventDefault();
				return;
			}
			const stepPercent = options.getStepPercent();
			const largeStepPercent = options.getLargeStepPercent();
			const rounded = roundToStep(options.getPercent(), stepPercent, 0);
			const horizontalSign = options.isRTL() ? -1 : 1;
			const step = event.shiftKey ? largeStepPercent : stepPercent;
			let newPercent = null;
			switch (event.key) {
				case "ArrowRight":
					newPercent = rounded + step * horizontalSign;
					break;
				case "ArrowLeft":
					newPercent = rounded - step * horizontalSign;
					break;
				case "ArrowUp":
					newPercent = rounded + step;
					break;
				case "ArrowDown":
					newPercent = rounded - step;
					break;
				case "PageUp":
					newPercent = rounded + largeStepPercent;
					break;
				case "PageDown":
					newPercent = rounded - largeStepPercent;
					break;
				case "Home":
					newPercent = 0;
					break;
				case "End":
					newPercent = 100;
					break;
			}
			if (newPercent !== null) {
				event.preventDefault();
				newPercent = clamp(newPercent, 0, 100);
				input.patch({
					pointerPercent: newPercent,
					dragPercent: newPercent
				});
				options.onValueChange?.(newPercent);
				options.onValueCommit?.(newPercent);
			}
		},
		onFocus() {
			input.patch({ focused: true });
		},
		onBlur() {
			input.patch({ focused: false });
		}
	};
	function adjustForAlignment(state) {
		if (!options.adjustPercent || state.thumbAlignment !== "edge") return state;
		const rootEl = options.getElement();
		const thumbEl = options.getThumbElement?.();
		if (!thumbEl) return state;
		const isHorizontal = state.orientation === "horizontal";
		const thumbSize = isHorizontal ? thumbEl.offsetWidth : thumbEl.offsetHeight;
		const trackSize = isHorizontal ? rootEl.offsetWidth : rootEl.offsetHeight;
		return {
			...state,
			fillPercent: options.adjustPercent(state.fillPercent, thumbSize, trackSize),
			pointerPercent: options.adjustPercent(state.pointerPercent, thumbSize, trackSize)
		};
	}
	let stopObservingResize = null;
	if (options.onResize) stopObservingResize = observeResize(options.getElement(), () => options.onResize());
	return {
		input,
		rootProps,
		rootStyle: {
			touchAction: "none",
			userSelect: "none"
		},
		thumbProps,
		adjustForAlignment,
		destroy() {
			if (abort.signal.aborted) return;
			abort.abort();
			stopObservingResize?.();
			releaseCapture();
			cleanup();
		}
	};
}

//#endregion
//#region ../core/dist/default/core/ui/slider/slider-css-vars.js
/** CSS custom property names for slider visual state. */
const SliderCSSVars = {
	/** Fill level percentage (0–100). */
	fill: "--media-slider-fill",
	/** Pointer position percentage (0–100). */
	pointer: "--media-slider-pointer",
	/** Buffer level percentage (0–100). */
	buffer: "--media-slider-buffer"
};

//#endregion
//#region ../core/dist/default/dom/ui/slider-css-vars.js
function getSliderCSSVars(state) {
	return {
		[SliderCSSVars.fill]: `${state.fillPercent.toFixed(3)}%`,
		[SliderCSSVars.pointer]: `${state.pointerPercent.toFixed(3)}%`
	};
}
function getTimeSliderCSSVars(state) {
	return {
		...getSliderCSSVars(state),
		[SliderCSSVars.buffer]: `${state.bufferPercent.toFixed(3)}%`
	};
}
/** Compute structural positioning styles for a slider preview element. */
function getSliderPreviewStyle(width, overflow) {
	const halfWidth = width / 2;
	return {
		position: "absolute",
		left: overflow === "visible" ? `calc(var(${SliderCSSVars.pointer}) - ${halfWidth}px)` : `min(max(0px, calc(var(${SliderCSSVars.pointer}) - ${halfWidth}px)), calc(100% - ${width}px))`,
		width: "max-content",
		pointerEvents: "none"
	};
}

//#endregion
//#region ../core/dist/default/dom/ui/slider-focus.js
function isSliderFocused(root = document) {
	const active = getDeepActiveElement(isDocument(root) ? root : root.ownerDocument);
	if (active?.getAttribute("role") !== "slider") return false;
	return isDocument(root) || containsComposed(root, active);
}

//#endregion
//#region ../core/dist/default/dom/ui/status-announcer.js
function subscribeToStatusAnnouncer(store, core) {
	let active = true;
	let pending = false;
	let target = store.target;
	let revision = 0;
	const baseline = () => {
		target = store.target;
		pending = true;
		const current = ++revision;
		core.resetSnapshot();
		queueMicrotask(() => {
			if (!active || current !== revision) return;
			pending = false;
			target = store.target;
			if (target) core.processSnapshot(getMediaSnapshot(store));
		});
	};
	const unsubscribe = store.subscribe(() => {
		const nextTarget = store.target;
		if (nextTarget !== target) {
			baseline();
			return;
		}
		if (!nextTarget || pending) return;
		core.processSnapshot(getMediaSnapshot(store));
	});
	baseline();
	return () => {
		active = false;
		unsubscribe();
	};
}
function shouldAnnounceStatusChange(container) {
	return !container || !isSliderFocused(container);
}

//#endregion
//#region ../utils/dist/array/find-last-at-or-before.js
/** Finds the index of the last ordered item whose value is at or before the target, or `-1` if none exists. */
function findLastIndexAtOrBefore(items, value, getValue) {
	let low = 0;
	let high = items.length - 1;
	let index = -1;
	while (low <= high) {
		const mid = low + high >>> 1;
		if (getValue(items[mid]) <= value) {
			index = mid;
			low = mid + 1;
		} else high = mid - 1;
	}
	return index;
}
/** Finds the last ordered item whose value is at or before the target. */
function findLastAtOrBefore(items, value, getValue) {
	const index = findLastIndexAtOrBefore(items, value, getValue);
	return index < 0 ? void 0 : items[index];
}

//#endregion
//#region ../utils/dist/array/find-range-at.js
/** Finds the ordered range containing the target value. */
function findRangeAt(ranges, value, getStart, getEnd) {
	const index = findLastIndexAtOrBefore(ranges, value, getStart);
	if (index < 0) return void 0;
	const range = ranges[index];
	const end = getEnd(range);
	const last = index === ranges.length - 1;
	return value < end || last && value === end ? range : void 0;
}

//#endregion
//#region ../core/dist/default/core/ui/thumbnail/thumbnail-core.js
var ThumbnailCore = class {
	findActiveThumbnail(thumbnails, time) {
		return findLastAtOrBefore(thumbnails, time, (thumbnail) => thumbnail.startTime);
	}
	/**
	* Parse CSS constraint strings into numeric `ThumbnailConstraints`.
	*
	* Accepts any object with string `minWidth`/`maxWidth`/`minHeight`/`maxHeight`
	* properties — `CSSStyleDeclaration` satisfies this structurally.
	*/
	parseConstraints(raw) {
		const minW = parseFloat(raw.minWidth);
		const maxW = parseFloat(raw.maxWidth);
		const minH = parseFloat(raw.minHeight);
		const maxH = parseFloat(raw.maxHeight);
		return {
			minWidth: Number.isFinite(minW) ? minW : 0,
			maxWidth: Number.isFinite(maxW) ? maxW : Infinity,
			minHeight: Number.isFinite(minH) ? minH : 0,
			maxHeight: Number.isFinite(maxH) ? maxH : Infinity
		};
	}
	/**
	* Calculate a uniform scale factor that fits `tileWidth × tileHeight` within the
	* given CSS min/max constraints while preserving aspect ratio.
	*
	* - Scales down when the tile exceeds max constraints.
	* - Scales up when the tile is smaller than min constraints.
	* - Returns `1` when no scaling is needed.
	*/
	calculateScale(tileWidth, tileHeight, constraints) {
		const { minWidth, maxWidth, minHeight, maxHeight } = constraints;
		const maxRatio = Math.min(maxWidth / tileWidth, maxHeight / tileHeight);
		const minRatio = Math.max(minWidth / tileWidth, minHeight / tileHeight);
		if (Number.isFinite(maxRatio) && maxRatio < 1) return maxRatio;
		if (Number.isFinite(minRatio) && minRatio > 1) return minRatio;
		return 1;
	}
	/**
	* Compute container and image dimensions for the current thumbnail, scaled to
	* fit within the element's CSS min/max constraints.
	*
	* The container clips the sprite sheet via `overflow: hidden`, and the image is
	* positioned with `transform: translate()` to show the correct tile.
	*/
	resize(thumbnail, imgNaturalWidth, imgNaturalHeight, constraints) {
		const tileWidth = thumbnail.width ?? imgNaturalWidth;
		const tileHeight = thumbnail.height ?? imgNaturalHeight;
		if (!tileWidth || !tileHeight) return void 0;
		const scale = this.calculateScale(tileWidth, tileHeight, constraints);
		const coordX = thumbnail.coords?.x ?? 0;
		const coordY = thumbnail.coords?.y ?? 0;
		const inset = scale !== 1 ? 1 : 0;
		return {
			scale,
			containerWidth: Math.max(0, Math.floor(tileWidth * scale) - inset * 2),
			containerHeight: Math.max(0, Math.floor(tileHeight * scale) - inset * 2),
			imageWidth: Math.ceil(imgNaturalWidth * scale),
			imageHeight: Math.ceil(imgNaturalHeight * scale),
			offsetX: Math.ceil(coordX * scale) + inset,
			offsetY: Math.ceil(coordY * scale) + inset
		};
	}
	getState(loading, error, thumbnail) {
		return {
			loading,
			error,
			hidden: !loading && !thumbnail
		};
	}
	getAttrs(_state) {
		return {
			role: "img",
			"aria-hidden": "true"
		};
	}
};

//#endregion
//#region ../core/dist/default/dom/ui/thumbnail.js
function createThumbnail(options) {
	const { getContainer, getImg, onStateChange } = options;
	const core = new ThumbnailCore();
	const abort = new AbortController();
	const signal = abort.signal;
	let loading = false;
	let error = false;
	let naturalWidth = 0;
	let naturalHeight = 0;
	let lastSrc = "";
	let imgBound = false;
	let stopObservingResize = null;
	function onImgLoad() {
		const img = getImg();
		if (img) {
			naturalWidth = img.naturalWidth;
			naturalHeight = img.naturalHeight;
		}
		loading = false;
		error = false;
		onStateChange();
	}
	function onImgError() {
		loading = false;
		error = true;
		onStateChange();
	}
	function bindImg(img) {
		listen(img, "load", onImgLoad, { signal });
		listen(img, "error", onImgError, { signal });
	}
	function ensureBindings() {
		if (!imgBound) {
			const img = getImg();
			if (img) {
				bindImg(img);
				imgBound = true;
			}
		}
		if (!stopObservingResize) {
			const container = getContainer();
			if (container) stopObservingResize = observeResize(container, onStateChange);
		}
	}
	function updateSrc(url) {
		ensureBindings();
		const src = url ?? "";
		if (src === lastSrc) return;
		lastSrc = src;
		if (src) {
			loading = true;
			error = false;
		} else {
			loading = false;
			error = false;
			naturalWidth = 0;
			naturalHeight = 0;
		}
	}
	function connect() {
		ensureBindings();
		const img = getImg();
		if (img?.complete && lastSrc) {
			if (img.naturalWidth > 0) {
				naturalWidth = img.naturalWidth;
				naturalHeight = img.naturalHeight;
				loading = false;
				error = false;
			} else {
				loading = false;
				error = true;
			}
			onStateChange();
		}
	}
	function destroy() {
		abort.abort();
		stopObservingResize?.();
		stopObservingResize = null;
	}
	return {
		get loading() {
			return loading;
		},
		get error() {
			return error;
		},
		get naturalWidth() {
			return naturalWidth;
		},
		get naturalHeight() {
			return naturalHeight;
		},
		readConstraints() {
			const el = getContainer();
			if (!el) return {
				minWidth: 0,
				maxWidth: Infinity,
				minHeight: 0,
				maxHeight: Infinity
			};
			return core.parseConstraints(getComputedStyle(el));
		},
		updateSrc,
		connect,
		destroy
	};
}

//#endregion
//#region ../core/dist/default/dom/ui/tooltip/tooltip.js
/** Map popover reasons to tooltip reasons, filtering out click/outside-click. */
const REASON_MAP = {
	hover: "hover",
	focus: "focus",
	escape: "escape",
	blur: "blur",
	"imperative-action": "imperative-action"
};
function createTooltip(options) {
	const popoverOpts = {
		transition: options.transition,
		onOpenChange(open, details) {
			const reason = REASON_MAP[details.reason];
			if (!reason) return;
			const group = options.group?.();
			if (open) group?.notifyOpen();
			else group?.notifyClose();
			const tooltipDetails = details.event ? {
				reason,
				event: details.event
			} : { reason };
			options.onOpenChange(open, tooltipDetails);
		},
		closeOnEscape: () => true,
		closeOnOutsideClick: () => false,
		openOnHover: () => true,
		delay: () => {
			const group = options.group?.();
			if (group?.shouldSkipDelay()) return 0;
			return options.delay?.() ?? group?.delay ?? 600;
		},
		closeDelay: () => {
			const group = options.group?.();
			return options.closeDelay?.() ?? group?.closeDelay ?? 0;
		}
	};
	if (options.onOpenChangeComplete) popoverOpts.onOpenChangeComplete = options.onOpenChangeComplete;
	const popover = createPopover(popoverOpts);
	let isPointerDown = false;
	let popupGroup;
	let unsubscribe;
	function isTriggerPopupOpen() {
		return popupGroup?.isOpenFor(popover.triggerElement) ?? false;
	}
	function syncPopupGroup() {
		const next = options.popupGroup?.();
		if (next === popupGroup) return;
		unsubscribe?.();
		popupGroup = next;
		unsubscribe = popupGroup?.subscribe(() => {
			if (isTriggerPopupOpen()) popover.close("imperative-action");
		});
	}
	function setTriggerElement(el) {
		popover.setTriggerElement(el);
		syncPopupGroup();
		if (isTriggerPopupOpen()) popover.close("imperative-action");
	}
	const { onClick: _, ...baseTriggerProps } = popover.triggerProps;
	const triggerProps = {
		...baseTriggerProps,
		onPointerDown() {
			syncPopupGroup();
			isPointerDown = true;
			popover.close("imperative-action");
		},
		onPointerEnter(event) {
			syncPopupGroup();
			if (options.disabled?.()) return;
			if (isTriggerPopupOpen()) return;
			if (event.pointerType === "touch") return;
			baseTriggerProps.onPointerEnter(event);
		},
		onFocusIn(event) {
			syncPopupGroup();
			if (options.disabled?.()) return;
			if (isTriggerPopupOpen()) return;
			if (isPointerDown) {
				isPointerDown = false;
				return;
			}
			baseTriggerProps.onFocusIn(event);
		}
	};
	const popupProps = {
		...popover.popupProps,
		onPointerEnter(event) {
			if (options.disableHoverablePopup?.()) return;
			popover.popupProps.onPointerEnter(event);
		}
	};
	return {
		...popover,
		triggerProps,
		popupProps,
		get triggerElement() {
			return popover.triggerElement;
		},
		setTriggerElement,
		open: () => {
			syncPopupGroup();
			if (!isTriggerPopupOpen()) popover.open("hover");
		},
		close: (reason = "hover") => popover.close(reason),
		destroy() {
			unsubscribe?.();
			popover.destroy();
		}
	};
}

//#endregion
//#region ../core/dist/default/dom/ui/transition.js
/**
* Manages open/close transition lifecycle via `createState`.
*
* **Open:** patches `{ active: true, status: 'starting' }`, then after a
* double-RAF patches `{ status: 'idle' }` so the browser paints the
* initial ("from") state before transitioning. It then waits for the resulting
* element animations to finish. Reopening an active transition flushes styles
* first so CSS transitions can restart.
*
* **Close:** patches `{ status: 'ending' }` (keeping `active: true` so the
* element stays mounted), then after a double-RAF waits for
* `getAnimations()` to settle before patching `{ active: false, status: 'idle' }`.
*/
function createTransition() {
	const state = createState({
		active: false,
		status: "idle"
	});
	let destroyed = false;
	let rafId1 = 0;
	let rafId2 = 0;
	let operationId = 0;
	let resolvePending = null;
	function cancelFrames() {
		cancelAnimationFrame(rafId1);
		cancelAnimationFrame(rafId2);
		rafId1 = 0;
		rafId2 = 0;
	}
	function beginOperation() {
		operationId++;
		cancelFrames();
		resolvePending?.();
		resolvePending = null;
		return operationId;
	}
	function finishOperation(id) {
		if (id !== operationId) return;
		const resolve = resolvePending;
		resolvePending = null;
		resolve?.();
	}
	function open(el = null) {
		if (destroyed) return Promise.resolve();
		const id = beginOperation();
		const restarting = state.current.active;
		if (restarting) state.patch({ status: "idle" });
		state.patch({
			active: true,
			status: "starting"
		});
		return new Promise((resolve) => {
			resolvePending = resolve;
			rafId1 = requestAnimationFrame(() => {
				rafId1 = 0;
				if (restarting) {
					const element = resolveElement(el);
					cancelAnimations(element);
					flushStyles(element);
				}
				rafId2 = requestAnimationFrame(() => {
					rafId2 = 0;
					if (destroyed || id !== operationId || !state.current.active) return finishOperation(id);
					state.patch({ status: "idle" });
					rafId1 = requestAnimationFrame(() => {
						rafId1 = 0;
						if (destroyed || id !== operationId || !state.current.active) return finishOperation(id);
						waitForAnimations(resolveElement(el)).finally(() => finishOperation(id));
					});
				});
			});
		});
	}
	function close(el) {
		if (destroyed) return Promise.resolve();
		const id = beginOperation();
		state.patch({ status: "ending" });
		return new Promise((resolve) => {
			resolvePending = resolve;
			rafId1 = requestAnimationFrame(() => {
				rafId1 = 0;
				rafId2 = requestAnimationFrame(() => {
					rafId2 = 0;
					if (destroyed || id !== operationId) return finishOperation(id);
					waitForAnimations(el).finally(() => {
						if (destroyed || id !== operationId || state.current.status !== "ending") return finishOperation(id);
						state.patch({
							active: false,
							status: "idle"
						});
						finishOperation(id);
					});
				});
			});
		});
	}
	function cancel() {
		operationId++;
		cancelFrames();
		resolvePending?.();
		resolvePending = null;
		if (state.current.status !== "idle") state.patch({ status: "idle" });
	}
	return {
		state,
		open,
		close,
		cancel,
		destroy() {
			if (destroyed) return;
			destroyed = true;
			cancel();
		}
	};
}
function resolveElement(element) {
	return typeof element === "function" ? element() : element;
}
function flushStyles(el) {
	if (!el) return;
	el.offsetHeight;
}
function cancelAnimations(el) {
	const animations = el?.getAnimations?.({ subtree: true }) ?? [];
	for (const animation of animations) animation.cancel();
}
function waitForAnimations(el) {
	if (!el) return Promise.resolve();
	const animations = el.getAnimations?.() ?? [];
	if (animations.length === 0) return Promise.resolve();
	return Promise.all(animations.map((a) => a.finished)).then(noop, noop);
}

//#endregion
//#region ../core/dist/default/dom/ui/wheel-step.js
function createWheelStep(options) {
	return { onWheel(event) {
		if (options.isDisabled()) return;
		const direction = Math.sign(event.deltaY);
		if (direction === 0) return;
		event.preventDefault();
		const stepPercent = options.getStepPercent();
		const newPercent = clamp(options.getPercent() - direction * stepPercent, 0, 100);
		options.onValueChange?.(newPercent);
	} };
}

//#endregion
//#region ../core/dist/default/dom/utils/element-props.js
/**
* Apply props to a DOM element.
*
* Handles both attributes and event listeners:
* - Event props (onClick, onKeyDown, etc.) are attached as listeners
* - Boolean props: `true` sets empty attribute, `false` removes
* - `undefined` removes the attribute
* - Other props are set as string attributes
*/
function applyElementProps(element, props, options) {
	const signal = options?.signal;
	for (const [key, value] of Object.entries(props)) if (isFunction(value) && key.startsWith("on")) listen(element, key.slice(2).toLowerCase(), value, signal ? { signal } : void 0);
	else if (isUndefined(value) || value === false) element.removeAttribute(key);
	else if (value === true) element.setAttribute(key, "");
	else element.setAttribute(key, String(value));
}

//#endregion
//#region ../core/dist/default/dom/utils/state-data-attrs.js
/**
* Apply state as data attributes to an element.
*
* - `true` → sets `data-keyname=""`
* - truthy string/number → sets `data-keyname="value"`
* - falsy → removes the attribute
*
* @example
* ```ts
* const state = { paused: true, ended: false };
* applyStateDataAttrs(element, state);
* // element has data-paused="", data-ended is removed
* ```
*/
function applyStateDataAttrs(element, state, map) {
	for (const key in state) {
		if (map && !(key in map)) continue;
		const name = map?.[key] ?? toDataAttrName(key), value = state[key];
		if (value === true) element.setAttribute(name, "");
		else if (value) element.setAttribute(name, String(value));
		else element.removeAttribute(name);
	}
}
function toDataAttrName(key) {
	return `data-${key.toLowerCase()}`;
}

//#endregion
//#region ../html/dist/default/store/container-mixin.js
/**
* Create a mixin that consumes player context and registers itself as the
* container element with the provider via `containerContext`.
*
* @param config - Container configuration with player and container contexts.
*/
function createContainerMixin(config) {
	return (BaseClass) => {
		class PlayerContainerElement extends BaseClass {
			#contextStore = null;
			#setContainer = null;
			#popupGroup = createPopupGroup();
			#popupGroupProvider = new i(this, {
				context: popupGroupContext,
				initialValue: this.#popupGroup
			});
			constructor(...args) {
				super(...args);
				new s$1(this, {
					context: config.playerContext,
					callback: (value) => {
						this.#contextStore = value ?? null;
					},
					subscribe: true
				});
				new s$1(this, {
					context: config.containerContext,
					callback: (value) => {
						this.#setContainer = value?.setContainer ?? null;
						if (this.isConnected) this.#setContainer?.(this);
					},
					subscribe: true
				});
			}
			get store() {
				return this.#contextStore;
			}
			connectedCallback() {
				super.connectedCallback();
				this.#popupGroupProvider.setValue(this.#popupGroup);
				this.#setContainer?.(this);
			}
			disconnectedCallback() {
				super.disconnectedCallback();
				this.#setContainer?.(null);
			}
		}
		return PlayerContainerElement;
	};
}
/**
* Player container mixin configured for the default player contexts.
*
* Import this convenience mixin directly when composing a custom container.
*/
const ContainerMixin = createContainerMixin({
	playerContext,
	containerContext
});

//#endregion
//#region ../core/dist/default/i18n/text/container.js
const labelText$1 = {
	key: `container.label`,
	text: "Media player"
};

//#endregion
//#region ../html/dist/default/media/container-element.js
var MediaContainerElement = class extends ContainerMixin(MediaElement) {
	static {
		this.tagName = "media-container";
	}
	#i18n = new I18nController(this, i18nContext);
	#disconnect = null;
	#label = null;
	connectedCallback() {
		super.connectedCallback();
		applyContainerAttrs(this);
		this.#applyLabel();
		this.#disconnect = new AbortController();
		listen(this, "pointerup", this.#onPointerUp, { signal: this.#disconnect.signal });
	}
	disconnectedCallback() {
		super.disconnectedCallback();
		this.#disconnect?.abort();
		this.#disconnect = null;
	}
	update(changed) {
		super.update(changed);
		this.#applyLabel();
	}
	#applyLabel() {
		const current = this.getAttribute("aria-label");
		if (current && current !== this.#label) return;
		if (this.hasAttribute("aria-labelledby")) {
			if (current === this.#label) {
				this.removeAttribute("aria-label");
				this.#label = null;
			}
			return;
		}
		const label = this.#i18n.value(labelText$1);
		this.setAttribute("aria-label", label);
		this.#label = label;
	}
	#onPointerUp = () => {
		focusContainer(this);
	};
};

//#endregion
//#region ../html/dist/default/store/provider-mixin.js
/**
* Create a mixin that provides player context to descendant elements and
* owns the `store.attach()` lifecycle.
*
* Media and container elements register themselves via media/container
* contexts that carry both the current value and a setter. When a media
* element is available, the provider calls `store.attach({ media, container })`.
*
* As a fallback for plain `<video>`/`<audio>` that can't consume context,
* the provider queries its subtree after a microtask.
*
* @param options - Provider options with contexts, store factory, and feature configuration.
*/
function createProviderMixin(options) {
	const configKeys = Object.keys(options.config);
	return (BaseClass) => {
		class PlayerProviderElement extends BaseClass {
			static {
				this.properties = {
					...BaseClass.properties,
					...Object.fromEntries(configKeys.map((key) => [key, {
						type: String,
						attribute: kebabCase(key)
					}]))
				};
			}
			#store = options.factory();
			#configuredStore = null;
			#detach = null;
			#media = null;
			#container = null;
			#fallbackQueued = false;
			#setMedia = (media) => {
				if (this.#media === media) return;
				this.#media = media;
				this.#mediaProvider.setValue({
					media,
					setMedia: this.#setMedia
				});
				this.#tryAttach();
			};
			#setContainer = (container) => {
				if (this.#container === container) return;
				this.#container = container;
				this.#containerProvider.setValue({
					container,
					setContainer: this.#setContainer
				});
				this.#tryAttach();
			};
			#playerProvider = new i(this, {
				context: options.playerContext,
				initialValue: this.store
			});
			#mediaProvider = new i(this, {
				context: options.mediaContext,
				initialValue: {
					media: this.#media,
					setMedia: this.#setMedia
				}
			});
			#containerProvider = new i(this, {
				context: options.containerContext,
				initialValue: {
					container: this.#container,
					setContainer: this.#setContainer
				}
			});
			get store() {
				if (isNull(this.#store)) this.#store = options.factory();
				return this.#store;
			}
			connectedCallback() {
				this.#syncInitialConfig();
				super.connectedCallback();
				this.#playerProvider.setValue(this.store);
				this.#mediaProvider.setValue({
					media: this.#media,
					setMedia: this.#setMedia
				});
				this.#containerProvider.setValue({
					container: this.#container,
					setContainer: this.#setContainer
				});
				this.#tryAttach();
				this.#queueFallbackDiscovery();
			}
			disconnectedCallback() {
				super.disconnectedCallback();
				this.#detachStore();
			}
			destroyCallback() {
				this.#detachStore();
				this.#store?.destroy();
				this.#store = null;
				super.destroyCallback();
			}
			willUpdate(changed) {
				super.willUpdate(changed);
				for (const key of configKeys) {
					if (!changed.has(key)) continue;
					setPlayerConfigValue(this.store, options.config[key], this[key]);
				}
			}
			#tryAttach() {
				const store = this.#store;
				if (!store) return;
				if (!this.#media) {
					this.#detachStore();
					return;
				}
				const target = {
					media: this.#media,
					container: this.#container
				};
				const hasMediaChanged = store.target?.media !== target.media;
				const hasContainerChanged = store.target?.container !== target.container;
				if (hasMediaChanged || hasContainerChanged) {
					this.#detachStore();
					this.#detach = store.attach(target);
				}
			}
			#detachStore() {
				this.#detach?.();
				this.#detach = null;
			}
			#syncInitialConfig() {
				const store = this.store;
				if (this.#configuredStore === store) return;
				for (const key of configKeys) setPlayerConfigValue(store, options.config[key], this[key]);
				this.#configuredStore = store;
			}
			#queueFallbackDiscovery() {
				if (this.#media || this.#fallbackQueued) return;
				this.#fallbackQueued = true;
				queueMicrotask(() => {
					this.#fallbackQueued = false;
					if (this.#media) return;
					const media = this.querySelector("video, audio");
					if (media) this.#setMedia(media);
				});
			}
		}
		return PlayerProviderElement;
	};
}

//#endregion
//#region ../store/dist/default/html/controllers/snapshot-controller.js
/**
* Subscribe to a `State<T>` container with optional selector.
*
* Without selector: returns full state, re-renders on any state change.
* With selector: returns selected slice, re-renders only when the slice changes (shallowEqual).
*
* @example
* ```ts
* #state = new SnapshotController(this, sliderState, (s) => s.value);
* ```
*/
var SnapshotController = class {
	#host;
	#selector;
	#state;
	#cached;
	#unsubscribe = noop;
	constructor(host, state, selector) {
		this.#host = host;
		this.#state = state;
		this.#selector = selector;
		host.addController(this);
	}
	get value() {
		if (!this.#selector) return this.#state.current;
		this.#cached ??= this.#selector(this.#state.current);
		return this.#cached;
	}
	/** Switch to tracking a different state container. */
	track(state) {
		this.#state = state;
		this.#subscribe();
	}
	hostConnected() {
		this.#subscribe();
	}
	hostDisconnected() {
		this.#unsubscribe();
		this.#unsubscribe = noop;
		this.#cached = void 0;
	}
	#subscribe() {
		this.#unsubscribe();
		if (!this.#selector) {
			this.#unsubscribe = this.#state.subscribe(() => this.#host.requestUpdate());
			return;
		}
		const selector = this.#selector;
		this.#cached = selector(this.#state.current);
		this.#unsubscribe = this.#state.subscribe(() => {
			const next = selector(this.#state.current);
			if (!shallowEqual(this.#cached, next)) {
				this.#cached = next;
				this.#host.requestUpdate();
			}
		});
	}
};

//#endregion
//#region ../store/dist/default/html/store-accessor.js
/**
* Resolves a store from either a direct instance or context.
*
* When given a direct store, provides immediate access.
* When given a context, sets up a ContextConsumer to receive the store.
*
* @example Direct store
* ```ts
* const accessor = new StoreAccessor(host, store, (s) => console.log('available', s));
* accessor.value; // Store (immediately available)
* ```
*
* @example Context source
* ```ts
* const accessor = new StoreAccessor(host, context, (s) => console.log('available', s));
* accessor.value; // null until context provides store
* ```
*/
var StoreAccessor = class {
	#onAvailable;
	#consumer;
	#directStore;
	constructor(host, source, onAvailable) {
		this.#onAvailable = onAvailable ?? noop;
		if (isStore(source)) {
			this.#directStore = source;
			this.#consumer = null;
		} else {
			this.#directStore = null;
			this.#consumer = new s$1(host, {
				context: source,
				callback: (store) => this.#onAvailable(store),
				subscribe: false
			});
		}
		host.addController(this);
	}
	/** Returns the store, or null if not yet available from context. */
	get value() {
		if (this.#consumer) return this.#consumer.value ?? null;
		return this.#directStore;
	}
	hostConnected() {
		if (this.#directStore) this.#onAvailable(this.#directStore);
	}
};

//#endregion
//#region ../store/dist/default/html/controllers/store-controller.js
/**
* Access store state and actions.
*
* Without selector: Returns the store, does NOT subscribe to changes.
* With selector: Returns selected state, triggers update when selected state changes (shallowEqual).
*
* @example
* ```ts
* // Store access (no subscription) - access actions
* class Controls extends LitElement {
*   #store = new StoreController(this, storeSource);
*
*   handleClick() {
*     this.#store.value.setVolume(0.5);
*   }
* }
*
* // Selector-based subscription - re-renders when playback changes
* class PlayButton extends LitElement {
*   #playback = new StoreController(this, storeSource, selectPlayback);
*
*   render() {
*     const playback = this.#playback.value;
*     if (!playback) return nothing;
*     return html`<button @click=${playback.toggle}>
*       ${playback.paused ? 'Play' : 'Pause'}
*     </button>`;
*   }
* }
* ```
*/
var StoreController = class {
	#host;
	#selector;
	#accessor;
	#snapshot = null;
	constructor(host, source, selector) {
		this.#host = host;
		this.#selector = selector;
		this.#accessor = new StoreAccessor(host, source, (store) => this.#connect(store));
		host.addController(this);
	}
	get value() {
		const store = this.#accessor.value;
		if (isNull(store)) throw new Error("Store not available");
		if (isUndefined(this.#selector)) return store;
		return this.#snapshot.value;
	}
	hostConnected() {}
	#connect(store) {
		if (isUndefined(this.#selector)) return;
		if (!this.#snapshot) this.#snapshot = new SnapshotController(this.#host, store.$state, this.#selector);
		else this.#snapshot.track(store.$state);
	}
};

//#endregion
//#region ../html/dist/default/player/player-controller.js
/**
* Reactive controller for accessing player store state.
*
* Without selector: Returns the store, does NOT subscribe to changes.
* With selector: Returns selected state, subscribes with shallowEqual comparison.
*
* @example
* ```ts
* // Store access (no subscription)
* class Controls extends MediaElement {
*   #player = new PlayerController(this, playerContext);
*
*   handleClick() {
*     this.#player.value.setVolume(0.5);
*   }
* }
*
* // Selector-based subscription
* class PlayButton extends MediaElement {
*   #playback = new PlayerController(this, playerContext, selectPlayback);
* }
* ```
*/
var PlayerController = class {
	#host;
	#selector;
	#consumer;
	#store = null;
	constructor(host, context, selector) {
		this.#host = host;
		this.#selector = selector;
		this.#consumer = new s$1(host, {
			context,
			callback: (ctx) => this.#connect(ctx),
			subscribe: true
		});
		host.addController(this);
	}
	get value() {
		const store = this.#consumer.value;
		if (!store) return void 0;
		if (!this.#selector) return store;
		return this.#store?.value;
	}
	get displayName() {
		return this.#selector?.displayName;
	}
	hostConnected() {
		const store = this.#consumer.value;
		if (store) this.#connect(store);
	}
	hostDisconnected() {
		this.#store = null;
	}
	#connect(store) {
		if (!this.#store && this.#selector) this.#store = new StoreController(this.#host, store, this.#selector);
	}
};

//#endregion
//#region ../html/dist/default/player/create-player.js
function createPlayer(config) {
	const slice = combine(...config.features);
	const featureConfig = combinePlayerFeatureConfigs(config.features);
	function create() {
		return createStore()(slice);
	}
	return {
		context: playerContext,
		create,
		PlayerController,
		ProviderMixin: createProviderMixin({
			playerContext,
			mediaContext,
			containerContext,
			factory: create,
			config: featureConfig
		})
	};
}

//#endregion
//#region ../html/dist/default/define/video/player.js
const { ProviderMixin } = createPlayer({ features: videoFeatures });
var VideoPlayerElement = class extends ProviderMixin(MediaElement) {
	static {
		this.tagName = "video-player";
	}
};
safeDefine(VideoPlayerElement);
safeDefine(MediaContainerElement);

//#endregion
//#region ../html/dist/default/i18n/render-text.js
/** Render a text descriptor as keyed media-text markup. */
function renderText(text, attrs) {
	const attrText = Object.entries(attrs ?? {}).map(([key, value]) => ` ${key}="${escapeHtml(value)}"`).join("");
	return `<media-text token="${escapeHtml(text.key)}"${attrText}>${escapeHtml(text.text)}</media-text>`;
}

//#endregion
//#region ../html/dist/default/_virtual/inline-css_src/define/global.js
var global_default = "video-player,live-video-player,media-i18n{display:contents}video-player video,video-player [slot=poster],live-video-player video,live-video-player [slot=poster]{width:100%;height:100%;display:block}video-player video::-webkit-media-text-track-container,live-video-player video::-webkit-media-text-track-container{z-index:1;scale:.98;translate:0 var(--media-caption-track-y,0);transition:translate var(--media-caption-track-duration,0) ease-out;transition-delay:var(--media-caption-track-delay,0);font-family:inherit}";

//#endregion
//#region ../html/dist/default/_virtual/inline-css_src/define/shared.js
var shared_default = "media-tooltip-group{display:contents}:host{width:100%;display:grid}media-container{min-width:0;min-height:0}.media-popover--volume:has(media-volume-slider[data-hidden]){display:none}";

//#endregion
//#region ../html/dist/default/define/skin-element.js
const STYLES_ID = "__media-styles";
const sharedSheet = createShadowStyle(shared_default);
/**
* Base element for skin definitions. Attaches a shadow root, clones
* `static template` into it, and applies shared + per-skin styles
* via `adoptedStyleSheets` (or `<style>` fallback).
*/
var SkinElement = class extends ReactiveElement {
	static get observedAttributes() {
		return [...super.observedAttributes, "placeholdersrc"];
	}
	attributeChangedCallback(attr, oldValue, newValue) {
		super.attributeChangedCallback(attr, oldValue, newValue);
		if (attr === "placeholdersrc") if (newValue) this.style.setProperty("--media-poster-placeholder", `url(${newValue})`);
		else this.style.removeProperty("--media-poster-placeholder");
	}
	static {
		this.shadowRootOptions = { mode: "open" };
	}
	constructor() {
		super();
		ensureGlobalStyle(STYLES_ID, global_default);
		if (!this.shadowRoot) {
			const ctor = this.constructor;
			this.attachShadow(ctor.shadowRootOptions);
			if (ctor.template) renderTemplate(this.shadowRoot, ctor.template);
			const sheets = [sharedSheet];
			if (ctor.styles) sheets.push(ctor.styles);
			applyShadowStyles(this.shadowRoot, sheets);
		}
	}
};

//#endregion
//#region ../html/dist/default/icons/dist/render/default/index.js
const icons = {
	"airplay-enter": `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" aria-hidden="true" viewBox="0 0 18 18"><path d="M14.5 2A3.5 3.5 0 0 1 18 5.5v5l-.005.18a3.5 3.5 0 0 1-3.027 3.288L13 12h1.5a1.5 1.5 0 0 0 1.5-1.5v-5A1.5 1.5 0 0 0 14.5 4h-11A1.5 1.5 0 0 0 2 5.5v5A1.5 1.5 0 0 0 3.5 12H5l-1.968 1.967A3.5 3.5 0 0 1 0 10.5v-5A3.5 3.5 0 0 1 3.5 2z"/><path d="M8.631 10.902a.5.5 0 0 1 .738 0l4.363 4.76a.5.5 0 0 1-.369.838H4.637a.5.5 0 0 1-.369-.838z"/></svg>`,
	"airplay-exit": `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" aria-hidden="true" viewBox="0 0 18 18"><style>@keyframes media-icon--airplay__triangle{0%{translate:0 0}to{translate:0-2px}}@keyframes media-icon--airplay__fill{0%{fill-opacity:0}to{fill-opacity:.2}}</style><path fill-opacity=".2" d="M14.5 2A3.5 3.5 0 0 1 18 5.5v5a3.5 3.5 0 0 1-3.032 3.468L9.354 8.354a.5.5 0 0 0-.708 0l-5.615 5.614A3.5 3.5 0 0 1 0 10.5v-5A3.5 3.5 0 0 1 3.5 2z" style="animation:var(--media-icon--airplay__fill-animation, media-icon--airplay__fill 1s ease-in-out infinite alternate)"/><path d="M14.5 2A3.5 3.5 0 0 1 18 5.5v5l-.005.18a3.5 3.5 0 0 1-3.027 3.288L13 12h1.5a1.5 1.5 0 0 0 1.5-1.5v-5A1.5 1.5 0 0 0 14.5 4h-11A1.5 1.5 0 0 0 2 5.5v5A1.5 1.5 0 0 0 3.5 12H5l-1.968 1.967A3.5 3.5 0 0 1 0 10.5v-5A3.5 3.5 0 0 1 3.5 2z"/><path d="M8.631 10.902a.5.5 0 0 1 .738 0l4.363 4.76a.5.5 0 0 1-.369.838H4.637a.5.5 0 0 1-.369-.838z" style="animation:var(--media-icon--airplay__triangle-animation, media-icon--airplay__triangle 1s ease-in-out infinite alternate)"/></svg>`,
	"captions-off": `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" aria-hidden="true" viewBox="0 0 18 18"><rect width="16" height="12" x="1" y="3" stroke="currentColor" stroke-width="2" rx="3"/><rect width="3" height="2" x="3" y="8" fill="currentColor" fill-opacity=".5" rx="1"/><rect width="2" height="2" x="13" y="8" fill="currentColor" fill-opacity=".5" rx="1"/><rect width="4" height="2" x="11" y="11" fill="currentColor" fill-opacity=".5" rx="1"/><rect width="5" height="2" x="7" y="8" fill="currentColor" fill-opacity=".5" rx="1"/><rect width="7" height="2" x="3" y="11" fill="currentColor" fill-opacity=".5" rx="1"/></svg>`,
	"captions-on": `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" aria-hidden="true" viewBox="0 0 18 18"><path d="M15 2a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H3a3 3 0 0 1-3-3V5a3 3 0 0 1 3-3zM4 11a1 1 0 1 0 0 2h5a1 1 0 1 0 0-2zm8 0a1 1 0 1 0 0 2h2a1 1 0 1 0 0-2zM4 8a1 1 0 0 0 0 2h1a1 1 0 0 0 0-2zm4 0a1 1 0 0 0 0 2h3a1 1 0 1 0 0-2zm6 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2"/></svg>`,
	"cast-enter": `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" aria-hidden="true" viewBox="0 0 18 18"><path d="M14.5 2A3.5 3.5 0 0 1 18 5.5v7l-.005.18a3.5 3.5 0 0 1-3.315 3.315L14.5 16h-7c0-.693-.096-1.363-.271-2H14.5a1.5 1.5 0 0 0 1.5-1.5v-7A1.5 1.5 0 0 0 14.5 4h-11A1.5 1.5 0 0 0 2 5.5v3.271A7.5 7.5 0 0 0 0 8.5v-3A3.5 3.5 0 0 1 3.5 2zM0 12a4 4 0 0 1 4 4H2.5A2.5 2.5 0 0 0 0 13.5z"/><path d="M0 9.5A6.5 6.5 0 0 1 6.5 16H5a5 5 0 0 0-5-5zm0 5A1.5 1.5 0 0 1 1.5 16h-1a.5.5 0 0 1-.5-.5z"/></svg>`,
	"cast-exit": `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" aria-hidden="true" viewBox="0 0 18 18"><path d="M14.5 2A3.5 3.5 0 0 1 18 5.5v7a3.5 3.5 0 0 1-3.5 3.5h-7c0-.693-.096-1.363-.271-2H14.5a1.5 1.5 0 0 0 1.5-1.5v-7A1.5 1.5 0 0 0 14.5 4h-11A1.5 1.5 0 0 0 2 5.5v3.271A7.5 7.5 0 0 0 0 8.5v-3A3.5 3.5 0 0 1 3.5 2z"/><path d="M13.5 5.5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H6.634A7.53 7.53 0 0 0 3.5 9.366V6.5a1 1 0 0 1 1-1zM0 12a4 4 0 0 1 4 4H2.5A2.5 2.5 0 0 0 0 13.5z"/><path d="M0 9.5A6.5 6.5 0 0 1 6.5 16H5a5 5 0 0 0-5-5zm0 5A1.5 1.5 0 0 1 1.5 16h-1a.5.5 0 0 1-.5-.5z"/></svg>`,
	"check": `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" aria-hidden="true" viewBox="0 0 18 18"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 10.455 6.5 13 14 5"/></svg>`,
	"chevron": `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" aria-hidden="true" viewBox="0 0 18 18"><path stroke="currentColor" stroke-linecap="round" stroke-width="2" d="m11.964 9.014-4.95-4.95m0 9.9 4.95-4.95"/></svg>`,
	"fullscreen-enter": `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" aria-hidden="true" viewBox="0 0 18 18"><path d="M9.57 3.617A1 1 0 0 0 8.646 3H4c-.552 0-1 .449-1 1v4.646a.996.996 0 0 0 1.001 1 1 1 0 0 0 .706-.293l4.647-4.647a1 1 0 0 0 .216-1.089m4.812 4.812a1 1 0 0 0-1.089.217l-4.647 4.647a.998.998 0 0 0 .708 1.706H14c.552 0 1-.449 1-1V9.353a1 1 0 0 0-.618-.924"/></svg>`,
	"fullscreen-exit": `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" aria-hidden="true" viewBox="0 0 18 18"><path d="M7.883 1.93a.99.99 0 0 0-1.09.217L2.146 6.793A.998.998 0 0 0 2.853 8.5H7.5c.551 0 1-.449 1-1V2.854a1 1 0 0 0-.617-.924m7.263 7.57H10.5c-.551 0-1 .449-1 1v4.646a.996.996 0 0 0 1.001 1.001 1 1 0 0 0 .706-.293l4.646-4.646a.998.998 0 0 0-.707-1.707z"/></svg>`,
	"gear": `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" aria-hidden="true" viewBox="0 0 18 18"><path d="M7.519 2.184c.357-1.578 2.605-1.579 2.962 0a1.518 1.518 0 0 0 2.292.949c1.368-.864 2.957.727 2.094 2.096-.56.886-.074 2.06.949 2.292 1.579.356 1.578 2.606 0 2.962a1.52 1.52 0 0 0-.95 2.293c.864 1.369-.725 2.96-2.093 2.095a1.52 1.52 0 0 0-2.292.95c-.357 1.578-2.606 1.578-2.962 0a1.52 1.52 0 0 0-2.292-.95c-1.368.864-2.957-.726-2.094-2.095a1.52 1.52 0 0 0-.949-2.293c-1.579-.356-1.579-2.606 0-2.962a1.52 1.52 0 0 0 .95-2.292c-.864-1.369.725-2.96 2.093-2.096.887.56 2.061.074 2.292-.95m1.48 3.474a3.343 3.343 0 1 0 .002 6.687 3.343 3.343 0 0 0-.002-6.687"/></svg>`,
	"pause": `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" aria-hidden="true" viewBox="0 0 18 18"><rect width="5" height="14" x="2" y="2" rx="1.75"/><rect width="5" height="14" x="11" y="2" rx="1.75"/></svg>`,
	"pip-enter": `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" aria-hidden="true" viewBox="0 0 18 18"><path d="M13 2a4 4 0 0 1 4 4v2.036A3.5 3.5 0 0 0 16.5 8H15V6.273C15 5.018 13.96 4 12.679 4H4.32C3.04 4 2 5.018 2 6.273v5.454C2 12.982 3.04 14 4.321 14H6v1.5q0 .255.036.5H4a4 4 0 0 1-4-4V6a4 4 0 0 1 4-4z"/><rect width="10" height="7" x="8" y="10" rx="2"/><path d="M7.129 5.547a.6.6 0 0 0-.656.13L3.677 8.473A.6.6 0 0 0 4.102 9.5h2.796c.332 0 .602-.27.602-.602V6.103a.6.6 0 0 0-.371-.556"/></svg>`,
	"pip-exit": `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" aria-hidden="true" viewBox="0 0 18 18"><path d="M13 2a4 4 0 0 1 4 4v2.036A3.5 3.5 0 0 0 16.5 8H15V6.273C15 5.018 13.96 4 12.679 4H4.32C3.04 4 2 5.018 2 6.273v5.454C2 12.982 3.04 14 4.321 14H6v1.5q0 .255.036.5H4a4 4 0 0 1-4-4V6a4 4 0 0 1 4-4z"/><rect width="10" height="7" x="8" y="10" rx="2"/><path d="M4.871 10.454a.6.6 0 0 0 .656-.131l2.796-2.796A.6.6 0 0 0 7.898 6.5H5.102a.603.603 0 0 0-.602.602v2.795a.6.6 0 0 0 .371.556"/></svg>`,
	"play": `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" aria-hidden="true" viewBox="0 0 18 18"><path d="m14.051 10.723-7.985 4.964a1.98 1.98 0 0 1-2.758-.638A2.06 2.06 0 0 1 3 13.964V4.036C3 2.91 3.895 2 5 2c.377 0 .747.109 1.066.313l7.985 4.964a2.057 2.057 0 0 1 .627 2.808c-.16.257-.373.475-.627.637"/></svg>`,
	"quality": `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" aria-hidden="true" viewBox="0 0 18 18"><path d="M11 3c2.828 0 4.243 0 5.121.878.879.879.88 2.294.88 5.122 0 2.829-.001 4.243-.88 5.121-.878.879-2.293.88-5.12.88H7c-2.83 0-4.243-.001-5.122-.88C1 13.243 1 11.828 1 9.001c0-2.83 0-4.244.879-5.123C2.758 3 4.172 3 7 3zM3.25 6v6h1.556V9.564h2.45V12h1.556V6H7.256v2.331h-2.45v-2.33zm6.396 6h2.39q.99 0 1.71-.367a2.65 2.65 0 0 0 1.11-1.043q.393-.672.394-1.59 0-.918-.397-1.59a2.65 2.65 0 0 0-1.116-1.04Q13.017 6 12.035 6h-2.39zm2.294-4.792q.89 0 1.318.455.428.452.428 1.337 0 .886-.424 1.341-.42.45-1.305.451h-.756V7.208z"/></svg>`,
	"restart": `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" aria-hidden="true" viewBox="0 0 18 18"><path d="M9 1a7.98 7.98 0 0 0-6.132 2.867l-1.441-1.44A.25.25 0 0 0 1 2.604V6.75c0 .138.112.25.25.25h4.146a.25.25 0 0 0 .177-.427L4.29 5.29A5.99 5.99 0 0 1 9 3a6 6 0 1 1-6 6H1a8 8 0 1 0 8-8"/><path d="m11.61 9.639-3.331 2.07a.826.826 0 0 1-1.15-.266.86.86 0 0 1-.129-.452V6.849C7 6.38 7.374 6 7.834 6c.158 0 .312.045.445.13l3.331 2.071a.858.858 0 0 1 0 1.438"/></svg>`,
	"seek": `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" aria-hidden="true" viewBox="0 0 18 18"><path d="M9 1a7.98 7.98 0 0 1 6.132 2.867l1.441-1.44a.25.25 0 0 1 .427.177V6.75a.25.25 0 0 1-.25.25h-4.146a.25.25 0 0 1-.177-.427L13.71 5.29A5.99 5.99 0 0 0 9 3a6 6 0 0 0-4.242 10.242l-1.415 1.415A8 8 0 0 1 9 1"/></svg>`,
	"speech": `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" aria-hidden="true" viewBox="0 0 18 18"><path d="M6 12a5 5 0 0 1 4.511 2.843c.273.57-.203 1.157-.835 1.157H2.325c-.633 0-1.109-.587-.836-1.157A5 5 0 0 1 6.001 12M8.5 8.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0"/><path fill-opacity=".5" d="M14.5 2A1.5 1.5 0 0 1 16 3.5v2A1.5 1.5 0 0 1 14.5 7H12l-1.146 1.146A.5.5 0 0 1 10 7.793v-.88A1.5 1.5 0 0 1 9 5.5v-2A1.5 1.5 0 0 1 10.5 2z"/></svg>`,
	"speed": `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" aria-hidden="true" viewBox="0 0 18 18"><path d="M9 18q-.213 0-.424-.012h.85Q9.214 18 9 18M9 2a8 8 0 0 1 8 8c0 1.975-.719 3.78-1.905 5.175a.75.75 0 0 1-1.204.018l-1.509-1.971a.75.75 0 0 1 .596-1.206h1.674a6 6 0 1 0-11.304 0h1.68a.75.75 0 0 1 .596 1.206l-1.507 1.971a.75.75 0 0 1-1.133.07l-.003.004A8 8 0 0 1 9 2"/><rect width="6" height="2" x="6" y="14" fill-opacity=".5" rx="1"/><path d="M8.3 6.318c.246-.64 1.154-.64 1.4 0L10.732 9h-.002a2 2 0 1 1-3.46 0h-.001z"/><g fill-opacity=".5"><circle cx="5" cy="10.25" r=".75"/><circle cx="13" cy="10.25" r=".75"/><circle cx="6" cy="7.25" r=".75"/><circle cx="12" cy="7.25" r=".75"/></g></svg>`,
	"spinner": `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2" aria-hidden="true" viewBox="0 0 18 18"><style>@keyframes media-spinner-fade{0%{opacity:1}to{opacity:0}}.media-spinner__segment{animation:var(--media-spinner-animation, media-spinner-fade 1s linear infinite);animation-delay:var(--media-spinner-delay)}</style><path d="M9 1.5v3" class="media-spinner__segment" opacity=".5" style="--media-spinner-delay:0s"/><path d="m14.5 3.5-2 2" class="media-spinner__segment" opacity=".45" style="--media-spinner-delay:0.125s"/><path d="M16.5 9h-3" class="media-spinner__segment" opacity=".4" style="--media-spinner-delay:0.25s"/><path d="m14.5 14.5-2-2" class="media-spinner__segment" opacity=".35" style="--media-spinner-delay:0.375s"/><path d="M9 16.5v-3" class="media-spinner__segment" opacity=".3" style="--media-spinner-delay:0.5s"/><path d="m3.5 14.5 2-2" class="media-spinner__segment" opacity=".25" style="--media-spinner-delay:0.625s"/><path d="M1.5 9h3" class="media-spinner__segment" opacity=".15" style="--media-spinner-delay:0.75s"/><path d="m3.5 3.5 2 2" class="media-spinner__segment" opacity=".1" style="--media-spinner-delay:0.875s"/></svg>`,
	"switches": `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" aria-hidden="true" viewBox="0 0 18 18"><path d="M12.5 9.5a3.5 3.5 0 1 1 0 7h-7a3.5 3.5 0 1 1 0-7zm-2 1.5a2 2 0 1 0 0 4h2a2 2 0 1 0 0-4z"/><path fill-opacity=".5" d="M12.5 1.5a3.5 3.5 0 1 1 0 7h-7a3.5 3.5 0 1 1 0-7zM5.5 3a2 2 0 1 0 0 4h2a2 2 0 1 0 0-4z"/></svg>`,
	"volume-high": `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" aria-hidden="true" viewBox="0 0 18 18"><path d="M15.6 3.3c-.4-.4-1-.4-1.4 0s-.4 1 0 1.4C15.4 5.9 16 7.4 16 9s-.6 3.1-1.8 4.3c-.4.4-.4 1 0 1.4.2.2.5.3.7.3.3 0 .5-.1.7-.3C17.1 13.2 18 11.2 18 9s-.9-4.2-2.4-5.7"/><path d="M.714 6.008h3.072l4.071-3.857c.5-.376 1.143 0 1.143.601V15.28c0 .602-.643.903-1.143.602l-4.071-3.858H.714c-.428 0-.714-.3-.714-.752V6.76c0-.451.286-.752.714-.752m10.568.59a.91.91 0 0 1 0-1.316.91.91 0 0 1 1.316 0c1.203 1.203 1.47 2.216 1.522 3.208q.012.255.011.51c0 1.16-.358 2.733-1.533 3.803a.7.7 0 0 1-.298.156c-.382.106-.873-.011-1.018-.156a.91.91 0 0 1 0-1.316c.57-.57.995-1.551.995-2.487 0-.944-.26-1.667-.995-2.402"/></svg>`,
	"volume-low": `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" aria-hidden="true" viewBox="0 0 18 18"><path d="M.714 6.008h3.072l4.071-3.857c.5-.376 1.143 0 1.143.601V15.28c0 .602-.643.903-1.143.602l-4.071-3.858H.714c-.428 0-.714-.3-.714-.752V6.76c0-.451.286-.752.714-.752m10.568.59a.91.91 0 0 1 0-1.316.91.91 0 0 1 1.316 0c1.203 1.203 1.47 2.216 1.522 3.208q.012.255.011.51c0 1.16-.358 2.733-1.533 3.803a.7.7 0 0 1-.298.156c-.382.106-.873-.011-1.018-.156a.91.91 0 0 1 0-1.316c.57-.57.995-1.551.995-2.487 0-.944-.26-1.667-.995-2.402"/></svg>`,
	"volume-off": `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" aria-hidden="true" viewBox="0 0 18 18"><path d="M.714 6.008h3.072l4.071-3.857c.5-.376 1.143 0 1.143.601V15.28c0 .602-.643.903-1.143.602l-4.071-3.858H.714c-.428 0-.714-.3-.714-.752V6.76c0-.451.286-.752.714-.752M14.5 7.586l-1.768-1.768a1 1 0 1 0-1.414 1.414L13.085 9l-1.767 1.768a1 1 0 0 0 1.414 1.414l1.768-1.768 1.768 1.768a1 1 0 0 0 1.414-1.414L15.914 9l1.768-1.768a1 1 0 0 0-1.414-1.414z"/></svg>`
};
function esc(v) {
	return String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function renderIcon(name, attrs) {
	const svg = icons[name];
	if (!svg) return "";
	if (!attrs) return svg;
	const attrStr = Object.entries(attrs).map(([k, v]) => ` ${k}="${esc(v)}"`).join("");
	return svg.replace("<svg", `<svg${attrStr}`);
}

//#endregion
//#region ../html/dist/default/i18n/locale.js
/** Delegates to {@link effectiveLocale}; result is typed as {@link Locale} for player UI. */
function resolvePlayerLocale(explicit, inherited) {
	return effectiveLocale(explicit, inherited);
}
/** Effective locale for an i18n provider element (explicit `lang` → ancestor `lang` chain → `en`). */
function resolveProviderLocale(host) {
	return resolvePlayerLocale(resolveLangAttr(host.lang), resolveLangAttr(findNearestLang(host.parentElement ?? (typeof document !== "undefined" ? document.documentElement : null))));
}

//#endregion
//#region ../html/dist/default/i18n/provider-mixin.js
function createI18nProviderMixin({ context, loader = loadLocale }) {
	return (Base) => {
		class I18nProviderElement extends Base {
			constructor(..._args) {
				super(..._args);
				this.lang = "";
				this.#i18nProvider = new i(this, {
					context,
					initialValue: {
						translator: getFallbackTranslator(),
						locale: "en"
					}
				});
				this.#registryEpoch = 0;
				this.#lazyLayer = {};
				this.#lazySeq = 0;
				this.#i18nValue = {
					translator: getFallbackTranslator(),
					locale: "en"
				};
				this.#publishedRegistryEpoch = -1;
			}
			static {
				this.properties = {
					...Base.properties,
					lang: {
						type: String,
						reflect: true
					}
				};
			}
			#i18nProvider;
			#registryUnsubscribe;
			#ambientUnsubscribe;
			#registryEpoch;
			#lazyLayer;
			#lazySeq;
			/** Tracks locale used for `#lazyLayer`; ambient `lang` can change without the `lang` property. */
			#resolvedLocaleForLazy;
			/** Locale snapshot when the current `#lazySeq` async load was started (see `willUpdate` drift guard). */
			#lazyResetStartedForLocale;
			#i18nValue;
			#publishedLocale;
			#publishedRegistryEpoch;
			#publishedLazyLayer;
			get i18nValue() {
				return this.#i18nValue;
			}
			connectedCallback() {
				super.connectedCallback();
				this.#registryUnsubscribe = onI18nRegistryChange(() => {
					this.#registryEpoch += 1;
					this.requestUpdate();
				});
				this.#ambientUnsubscribe = subscribeAmbientLang(() => this.requestUpdate());
				this.#resetLazyAndLoad();
				this.#publish();
				this.requestUpdate();
			}
			disconnectedCallback() {
				super.disconnectedCallback();
				this.#registryUnsubscribe?.();
				this.#registryUnsubscribe = void 0;
				this.#ambientUnsubscribe?.();
				this.#ambientUnsubscribe = void 0;
				this.#lazySeq += 1;
				this.#lazyLayer = {};
				this.#resolvedLocaleForLazy = void 0;
				this.#lazyResetStartedForLocale = void 0;
			}
			willUpdate(changed) {
				super.willUpdate(changed);
				const locale = resolveProviderLocale(this);
				if (this.#resolvedLocaleForLazy !== locale) {
					const hadLocale = this.#resolvedLocaleForLazy !== void 0;
					this.#resolvedLocaleForLazy = locale;
					const localeDriftedBeforeFirstPaint = !hadLocale && this.#lazyResetStartedForLocale !== void 0 && locale !== this.#lazyResetStartedForLocale;
					if (hadLocale || localeDriftedBeforeFirstPaint) this.#resetLazyAndLoad();
				}
				this.#publish();
			}
			#resetLazyAndLoad() {
				const localeSnapshot = resolveProviderLocale(this);
				this.#lazyResetStartedForLocale = localeSnapshot;
				this.#lazySeq += 1;
				const seq = this.#lazySeq;
				this.#lazyLayer = {};
				(async () => {
					const { merged, loadedTags } = await mergeLocaleOverlays(localeSnapshot, loader, findLocaleKeys);
					if (seq !== this.#lazySeq) return;
					if (shouldAttemptBrowserTranslation(localeSnapshot, loadedTags, merged)) {
						const browser = await getBrowserTranslations(localeSnapshot);
						if (seq !== this.#lazySeq) return;
						if (Object.keys(browser).length) registerI18n(localeSnapshot, browser);
					}
					if (seq !== this.#lazySeq) return;
					this.#lazyLayer = merged;
					this.requestUpdate();
				})();
			}
			#resolvedLocale() {
				return resolveProviderLocale(this);
			}
			#publish() {
				const locale = this.#resolvedLocale();
				if (this.#publishedLocale === locale && this.#publishedRegistryEpoch === this.#registryEpoch && this.#publishedLazyLayer === this.#lazyLayer) return;
				const translator = createTranslator({
					...getI18nTranslations(locale),
					...this.#lazyLayer
				}, locale);
				this.#i18nValue = {
					translator,
					locale
				};
				this.#publishedLocale = locale;
				this.#publishedRegistryEpoch = this.#registryEpoch;
				this.#publishedLazyLayer = this.#lazyLayer;
				this.#i18nProvider.setValue(this.#i18nValue);
			}
		}
		return I18nProviderElement;
	};
}

//#endregion
//#region ../html/dist/default/i18n/provider-element.js
const I18nProviderMixin = createI18nProviderMixin({ context: i18nContext });
var I18nProviderElement = class extends I18nProviderMixin(ReactiveElement) {
	static {
		this.tagName = "media-i18n";
	}
};

//#endregion
//#region ../html/dist/default/i18n/text-mixin.js
function createTextMixin({ context }) {
	return (Base) => {
		class MediaText extends Base {
			constructor(..._args) {
				super(..._args);
				this.#i18n = new I18nController(this, context);
				this.token = "";
			}
			static {
				this.properties = { token: { type: String } };
			}
			#i18n;
			#text;
			connectedCallback() {
				this.#text ??= this.textContent?.trim() ?? "";
				super.connectedCallback();
			}
			updated(changed) {
				super.updated(changed);
				if (!this.#text) {
					this.textContent = "";
					return;
				}
				const text = this.token ? {
					key: this.token,
					text: this.#text
				} : this.#text;
				this.textContent = typeof text === "string" ? text : translateText(text, this.#i18n.value);
			}
		}
		return MediaText;
	};
}

//#endregion
//#region ../html/dist/default/ui/text/text-element.js
const I18nTextMixin = createTextMixin({ context: i18nContext });
var TextElement = class extends I18nTextMixin(ReactiveElement) {
	static {
		this.tagName = "media-text";
	}
};

//#endregion
//#region ../html/dist/default/ui/hotkey/aria-key-shortcuts-controller.js
/** Provides hotkey shortcut metadata for a given hotkey action name. */
var AriaKeyShortcutsController = class {
	#host;
	#action;
	#getValue;
	#container;
	#unsubscribe = null;
	constructor(host, action, options = {}) {
		this.#host = host;
		this.#action = action;
		this.#getValue = options.value;
		this.#container = new s$1(host, {
			context: containerContext,
			callback: (ctx) => this.#connect(ctx?.container),
			subscribe: true
		});
		host.addController(this);
	}
	get value() {
		return this.aria;
	}
	get aria() {
		return this.details.aria;
	}
	get shortcut() {
		return this.details.shortcut;
	}
	get details() {
		const container = this.#container.value?.container;
		if (!container) return {};
		return getHotkeyCoordinator(container).getShortcut(this.#action, this.#getValue?.());
	}
	hostConnected() {
		this.#connect(this.#container.value?.container);
	}
	hostDisconnected() {
		this.#disconnect();
	}
	#connect(container) {
		this.#disconnect();
		if (!container) return;
		const coordinator = getHotkeyCoordinator(container);
		const notify = () => {
			this.#host.requestUpdate();
		};
		this.#unsubscribe = coordinator.subscribeShortcutChanges(notify);
		notify();
	}
	#disconnect() {
		this.#unsubscribe?.();
		this.#unsubscribe = null;
	}
};

//#endregion
//#region ../html/dist/default/ui/media-button-element.js
function getLabelParams(core, state) {
	return core.getLabelParams?.(state);
}
/** Abstract base for HTML custom elements that render a media-control button. */
var MediaButtonElement = class extends MediaElement {
	constructor(..._args) {
		super(..._args);
		this.disabled = false;
		this.label = "";
		this.hotkeyAction = void 0;
		this.#disconnect = null;
		this.#hotkeyRegistry = null;
		this.#i18n = new I18nController(this, i18nContext);
	}
	static {
		this.properties = {
			label: { type: String },
			disabled: { type: Boolean }
		};
	}
	getIsButtonDisabled() {
		return this.disabled || !this.mediaState.value;
	}
	handleActivate(event) {
		Promise.resolve(this.activate(this.mediaState.value, event)).catch((error) => {});
	}
	/** Override to match hotkeys that use action values, such as seek steps. */
	get hotkeyValue() {}
	get $state() {
		return this.core.state;
	}
	#disconnect;
	#hotkeyRegistry;
	#lastHotkeyShortcut;
	#i18n;
	connectedCallback() {
		super.connectedCallback();
		if (this.destroyed) return;
		if (this.hotkeyAction && !this.#hotkeyRegistry) this.#hotkeyRegistry = new AriaKeyShortcutsController(this, this.hotkeyAction, { value: () => this.hotkeyValue });
		this.#disconnect = new AbortController();
		const buttonProps = createButton({
			onActivate: (event) => this.handleActivate(event),
			isDisabled: () => this.getIsButtonDisabled()
		});
		applyElementProps(this, buttonProps, { signal: this.#disconnect.signal });
	}
	disconnectedCallback() {
		super.disconnectedCallback();
		this.#disconnect?.abort();
		this.#disconnect = null;
	}
	/** Returns the button's current label derived from media state. */
	getLabel() {
		return this.core.state.current.label ? resolveText(this.core.state.current.label) : void 0;
	}
	getShortcut() {
		return this.#hotkeyRegistry?.shortcut;
	}
	/** Resolved label for tooltips and other display surfaces. */
	getResolvedLabel() {
		const media = this.mediaState.value;
		if (!media) return void 0;
		this.core.setMedia(media);
		const state = this.core.getState();
		return translateText(this.core.getLabel(state), this.#i18n.value, getLabelParams(this.core, state));
	}
	willUpdate(changed) {
		super.willUpdate(changed);
		this.core.setProps?.(this);
	}
	update(changed) {
		super.update(changed);
		const media = this.mediaState.value;
		this.#syncHotkeyShortcut();
		if (!media) return;
		this.core.setMedia(media);
		const state = this.core.getState();
		const attrs = this.core.getAttrs?.(state) ?? {};
		if (isText(attrs["aria-label"])) attrs["aria-label"] = translateText(attrs["aria-label"], this.#i18n.value, getLabelParams(this.core, state));
		applyElementProps(this, {
			...attrs,
			"aria-keyshortcuts": this.#hotkeyRegistry?.aria,
			...isHideable(state) && { hidden: state.hidden ? "" : void 0 }
		});
		applyStateDataAttrs(this, state, this.stateAttrMap);
	}
	#syncHotkeyShortcut() {
		const shortcut = this.getShortcut();
		if (shortcut === this.#lastHotkeyShortcut) return;
		this.#lastHotkeyShortcut = shortcut;
		this.dispatchEvent(new CustomEvent(HOTKEY_SHORTCUT_CHANGE_EVENT));
	}
};
/** Whether a button's core reports whether it should be shown at all. */
function isHideable(state) {
	return isObject(state) && isBoolean(state.hidden);
}

//#endregion
//#region ../core/dist/default/i18n/text/airplay.js
const prefix$13 = "airplay.";
const startText$1 = {
	key: `${prefix$13}start`,
	text: "Start AirPlay"
};
const stopText$1 = {
	key: `${prefix$13}stop`,
	text: "Stop AirPlay"
};

//#endregion
//#region ../core/dist/default/i18n/text/cast.js
const prefix$12 = "cast.";
const startText = {
	key: `${prefix$12}start`,
	text: "Start casting"
};
const stopText = {
	key: `${prefix$12}stop`,
	text: "Stop casting"
};
const connectingText = {
	key: `${prefix$12}connecting`,
	text: "Connecting"
};

//#endregion
//#region ../core/dist/default/core/ui/utils/resolve-label.js
function resolveLabel(label, state) {
	if (isFunction(label)) return label(state) || void 0;
	return label || void 0;
}

//#endregion
//#region ../core/dist/default/core/ui/airplay-button/airplay-button-core.js
var AirPlayButtonCore = class AirPlayButtonCore {
	static defaultProps = {
		label: "",
		disabled: false
	};
	state = createState({
		state: "disconnected",
		availability: "unsupported",
		disabled: true,
		hidden: true,
		label: ""
	});
	#props = { ...AirPlayButtonCore.defaultProps };
	#media = null;
	constructor(props) {
		if (props) this.setProps(props);
	}
	setProps(props) {
		this.#props = defaults(props, AirPlayButtonCore.defaultProps);
	}
	getLabel(state) {
		const label = resolveLabel(this.#props.label, state);
		if (label) return label;
		if (state.state === "connected") return stopText$1;
		if (state.state === "connecting") return connectingText;
		return startText$1;
	}
	getAttrs(state) {
		return {
			"aria-label": this.getLabel(state),
			"aria-disabled": state.disabled ? "true" : void 0,
			hidden: state.hidden ? "" : void 0
		};
	}
	setMedia(media) {
		this.#media = media;
	}
	getState() {
		const media = this.#media;
		const availability = supportsWebKitAirPlay() ? media.remotePlaybackAvailability : "unsupported";
		this.state.patch({
			state: media.remotePlaybackState,
			availability,
			disabled: this.#props.disabled || availability !== "available",
			hidden: availability !== "available"
		});
		this.state.patch({ label: resolveText(this.getLabel(this.state.current)) });
		return this.state.current;
	}
	async toggle(media) {
		this.setMedia(media);
		if (this.getState().disabled) return;
		try {
			await media.toggleRemotePlayback();
		} catch {}
	}
};

//#endregion
//#region ../core/dist/default/core/ui/airplay-button/airplay-button-data-attrs.js
const AirPlayButtonDataAttrs = {
	/**
	* Current AirPlay connection state.
	*
	* @see https://developer.mozilla.org/en-US/docs/Web/API/RemotePlayback/state
	*/
	state: "data-airplay-state",
	/**
	* Whether AirPlay is available on the active platform and media.
	*
	* @see https://developer.mozilla.org/en-US/docs/Web/API/RemotePlayback
	*/
	availability: "data-availability",
	/** Present when the button is non-interactive (mirrors `aria-disabled`). */
	disabled: "data-disabled",
	/** Present when the button is hidden because AirPlay is unavailable. */
	hidden: "data-hidden"
};

//#endregion
//#region ../core/dist/default/core/ui/alert-dialog/alert-dialog-core.js
var AlertDialogCore = class {
	static defaultProps = {
		open: false,
		defaultOpen: false
	};
	/** Accept props for API consistency. Props are consumed by platform layers. */
	setProps(_props) {}
	#input = null;
	#titleId = void 0;
	#descriptionId = void 0;
	setInput(input) {
		this.#input = input;
	}
	setTitleId(id) {
		this.#titleId = id;
	}
	setDescriptionId(id) {
		this.#descriptionId = id;
	}
	getState() {
		const input = this.#input;
		return {
			open: input.active,
			status: input.status,
			titleId: this.#titleId,
			descriptionId: this.#descriptionId,
			...getTransitionFlags(input.status)
		};
	}
	getAttrs(state) {
		return {
			role: "alertdialog",
			"aria-modal": "true",
			"aria-labelledby": state.titleId,
			"aria-describedby": state.descriptionId
		};
	}
};

//#endregion
//#region ../core/dist/default/core/ui/alert-dialog/alert-dialog-data-attrs.js
const AlertDialogDataAttrs = {
	/** Present when the dialog is open. */
	open: "data-open",
	...TransitionDataAttrs
};

//#endregion
//#region ../core/dist/default/i18n/text/menu.js
const prefix$11 = "menu.";
const settingsText = {
	key: `${prefix$11}settings`,
	text: "Settings"
};
const qualityText = {
	key: `${prefix$11}quality`,
	text: "Quality"
};
const audioText = {
	key: `${prefix$11}audio`,
	text: "Audio"
};
const defaultText = {
	key: `${prefix$11}default`,
	text: "Default"
};
const speedText = {
	key: `${prefix$11}speed`,
	text: "Speed"
};
const captionsText = {
	key: `${prefix$11}captions`,
	text: "Captions"
};
const playbackRateText = {
	key: `${prefix$11}playbackRate`,
	text: "Playback rate"
};
const backText = {
	key: `${prefix$11}back`,
	text: "Back"
};
const offText = {
	key: `${prefix$11}off`,
	text: "Off"
};
const autoText = {
	key: `${prefix$11}auto`,
	text: "Auto"
};
const autoWithLabelText = {
	key: `${prefix$11}autoWithLabel`,
	text: "Auto ({label})"
};
const subtitlesText = {
	key: `${prefix$11}subtitles`,
	text: "Subtitles"
};

//#endregion
//#region ../core/dist/default/core/ui/audio-track-radio-group/audio-track-radio-group-core.js
function formatTrackLabel$1(track) {
	if (track.label) return track.label;
	if (track.language) return track.language;
	if (track.kind) return track.kind;
	return audioText;
}
function getTrackValue(track, index) {
	return track.id || String(index);
}
var AudioTrackRadioGroupCore = class AudioTrackRadioGroupCore {
	static defaultProps = {
		label: "",
		formatTrack: formatTrackLabel$1,
		disabled: false
	};
	state = createState({
		options: [],
		value: "",
		disabled: true,
		hidden: true,
		availability: "unavailable",
		label: ""
	});
	#props = { ...AudioTrackRadioGroupCore.defaultProps };
	#media = null;
	constructor(props) {
		if (props) this.setProps(props);
	}
	setProps(props) {
		this.#props = defaults(props, AudioTrackRadioGroupCore.defaultProps);
	}
	getLabel(state) {
		const label = resolveLabel(this.#props.label, state);
		if (label) return label;
		return audioText;
	}
	getTrackLabel(track) {
		return this.#props.formatTrack(track);
	}
	getAttrs(state) {
		return {
			"aria-label": this.getLabel(state),
			"aria-disabled": state.disabled ? "true" : void 0,
			hidden: state.hidden ? "" : void 0
		};
	}
	setMedia(media) {
		this.#media = media;
	}
	getState() {
		const media = this.#media;
		const enabledIndex = media.audioTrackList.findIndex((track) => track.enabled);
		const options = media.audioTrackList.map((track, index) => ({
			value: getTrackValue(track, index),
			label: this.getTrackLabel(track),
			disabled: false
		}));
		const availability = options.length > 1 ? "available" : "unavailable";
		this.state.patch({
			options,
			value: enabledIndex === -1 ? "" : getTrackValue(media.audioTrackList[enabledIndex], enabledIndex),
			disabled: this.#props.disabled || availability === "unavailable",
			hidden: availability === "unavailable",
			availability
		});
		this.state.patch({ label: resolveText(this.getLabel(this.state.current)) });
		return this.state.current;
	}
	select(media, value) {
		if (this.#props.disabled) return;
		if (!media.audioTrackList.some((track, index) => getTrackValue(track, index) === value)) return;
		media.selectAudioTrack(value);
	}
	selectValue(media, value) {
		this.select(media, value);
	}
};

//#endregion
//#region ../core/dist/default/core/ui/audio-track-radio-group/audio-track-radio-group-data-attrs.js
const AudioTrackRadioGroupDataAttrs = {
	/** Current audio track value. */
	value: "data-audio-track",
	/** Present when audio track selection is disabled. */
	disabled: "data-disabled",
	/** Present when audio track selection is unavailable. */
	hidden: "data-hidden",
	/** Indicates audio track availability (`available` or `unavailable`). */
	availability: "data-availability"
};

//#endregion
//#region ../core/dist/default/core/ui/buffering-indicator/buffering-indicator-core.js
var BufferingIndicatorCore = class BufferingIndicatorCore {
	static defaultProps = { delay: 500 };
	state = createState({ visible: false });
	#props = { ...BufferingIndicatorCore.defaultProps };
	#timer = null;
	setProps(props) {
		this.#props = defaults(props, BufferingIndicatorCore.defaultProps);
	}
	destroy() {
		this.#clearTimer();
	}
	update(media) {
		const buffering = media.waiting && !media.paused;
		if (buffering && !this.state.current.visible && !this.#timer) this.#timer = setTimeout(() => {
			this.#timer = null;
			this.state.patch({ visible: true });
		}, this.#props.delay);
		else if (!buffering) {
			this.#clearTimer();
			this.state.patch({ visible: false });
		}
	}
	#clearTimer() {
		if (this.#timer !== null) {
			clearTimeout(this.#timer);
			this.#timer = null;
		}
	}
};

//#endregion
//#region ../core/dist/default/core/ui/buffering-indicator/buffering-indicator-data-attrs.js
const BufferingIndicatorDataAttrs = { 
/** Present when the buffering indicator is visible (after delay). */
visible: "data-visible" };

//#endregion
//#region ../core/dist/default/i18n/text/captions.js
const prefix$10 = "captions.";
const enableText = {
	key: `${prefix$10}enable`,
	text: "Enable captions"
};
const disableText = {
	key: `${prefix$10}disable`,
	text: "Disable captions"
};

//#endregion
//#region ../core/dist/default/core/ui/captions-button/captions-button-core.js
var CaptionsButtonCore = class CaptionsButtonCore {
	static defaultProps = {
		label: "",
		disabled: false,
		menuTrigger: false
	};
	state = createState({
		subtitlesShowing: false,
		availability: "unavailable",
		disabled: true,
		hidden: true,
		label: ""
	});
	#props = { ...CaptionsButtonCore.defaultProps };
	#media = null;
	constructor(props) {
		if (props) this.setProps(props);
	}
	setProps(props) {
		this.#props = defaults(props, CaptionsButtonCore.defaultProps);
	}
	getLabel(state) {
		const label = resolveLabel(this.#props.label, state);
		if (label) return label;
		return state.subtitlesShowing ? disableText : enableText;
	}
	getAttrs(state) {
		return {
			"aria-label": this.getLabel(state),
			"aria-disabled": state.disabled ? "true" : void 0,
			hidden: state.hidden ? "" : void 0
		};
	}
	setMedia(media) {
		this.#media = media;
	}
	getState() {
		const media = this.#media;
		const availability = media.textTrackList.some(isCaptionOrSubtitleTrack) ? "available" : "unavailable";
		this.state.patch({
			subtitlesShowing: media.subtitlesShowing,
			availability,
			disabled: this.#props.disabled || availability !== "available",
			hidden: availability === "unavailable"
		});
		this.state.patch({ label: resolveText(this.getLabel(this.state.current)) });
		return this.state.current;
	}
	toggle(media) {
		this.setMedia(media);
		if (this.getState().disabled) return;
		if (this.#props.menuTrigger && getCaptionTrackCount$1(media) > 1) return;
		media.toggleSubtitles();
	}
};
function getCaptionTrackCount$1(media) {
	return media.textTrackList.filter(isCaptionOrSubtitleTrack).length;
}

//#endregion
//#region ../core/dist/default/core/ui/captions-button/captions-button-data-attrs.js
const CaptionsButtonDataAttrs = {
	/** Present when captions are enabled. */
	subtitlesShowing: "data-active",
	/** Indicates captions availability (`available` or `unavailable`). */
	availability: "data-availability",
	/** Present when the button is non-interactive (mirrors `aria-disabled`). */
	disabled: "data-disabled",
	/** Present when the button is hidden because no caption tracks are present. */
	hidden: "data-hidden"
};

//#endregion
//#region ../core/dist/default/core/ui/captions-radio-group/captions-radio-group-core.js
function formatTrackLabel(track) {
	if (track.label) return track.label;
	if (track.language) return track.language;
	return track.kind === "captions" ? captionsText : subtitlesText;
}
function sortCaptionTracks(a, b) {
	return a.kind > b.kind ? 1 : a.kind < b.kind ? -1 : 0;
}
function getCaptionTracks(textTrackList) {
	return textTrackList.filter(isCaptionOrSubtitleTrack).sort(sortCaptionTracks);
}
var CaptionsRadioGroupCore = class CaptionsRadioGroupCore {
	static defaultProps = {
		label: "",
		formatTrack: formatTrackLabel,
		disabled: false
	};
	state = createState({
		options: [{
			value: "off",
			label: offText,
			disabled: false
		}],
		value: "off",
		subtitlesShowing: false,
		disabled: true,
		hidden: true,
		availability: "unavailable",
		label: ""
	});
	#props = { ...CaptionsRadioGroupCore.defaultProps };
	#media = null;
	constructor(props) {
		if (props) this.setProps(props);
	}
	setProps(props) {
		this.#props = defaults(props, CaptionsRadioGroupCore.defaultProps);
	}
	getLabel(state) {
		const label = resolveLabel(this.#props.label, state);
		if (label) return label;
		return captionsText;
	}
	getTrackLabel(track) {
		return this.#props.formatTrack(track);
	}
	getAttrs(state) {
		return {
			"aria-label": this.getLabel(state),
			"aria-disabled": state.disabled ? "true" : void 0,
			hidden: state.hidden ? "" : void 0
		};
	}
	setMedia(media) {
		this.#media = media;
	}
	getState() {
		const media = this.#media;
		const captionTracks = getCaptionTracks(media.textTrackList);
		const showingIndex = captionTracks.findIndex((track) => track.mode === "showing");
		const options = [{
			value: "off",
			label: offText,
			disabled: false
		}, ...captionTracks.map((track, index) => ({
			value: track.id || String(index),
			label: this.getTrackLabel(track),
			disabled: false
		}))];
		const availability = captionTracks.length > 0 ? "available" : "unavailable";
		this.state.patch({
			options,
			value: showingIndex === -1 ? "off" : captionTracks[showingIndex].id || String(showingIndex),
			subtitlesShowing: media.subtitlesShowing,
			disabled: this.#props.disabled || captionTracks.length === 0,
			hidden: availability === "unavailable",
			availability
		});
		this.state.patch({ label: resolveText(this.getLabel(this.state.current)) });
		return this.state.current;
	}
	select(media, value) {
		if (this.#props.disabled) return;
		const captionTracks = getCaptionTracks(media.textTrackList);
		if (!captionTracks.length) return;
		if (value === "off") {
			media.selectSubtitlesTrack("off");
			return;
		}
		if (!captionTracks.some((track, index) => (track.id || String(index)) === value)) return;
		media.selectSubtitlesTrack(value);
	}
	selectValue(media, value) {
		this.select(media, value);
	}
};

//#endregion
//#region ../core/dist/default/core/ui/captions-radio-group/captions-radio-group-data-attrs.js
const CaptionsRadioGroupDataAttrs = {
	/** Present when captions are enabled. */
	subtitlesShowing: "data-active",
	/** Present when track selection is disabled. */
	disabled: "data-disabled",
	/** Present when track selection is unavailable. */
	hidden: "data-hidden",
	/** Indicates captions availability (`available` or `unavailable`). */
	availability: "data-availability"
};

//#endregion
//#region ../core/dist/default/core/ui/cast-button/cast-button-core.js
var CastButtonCore = class CastButtonCore {
	static defaultProps = {
		label: "",
		disabled: false
	};
	state = createState({
		connection: "disconnected",
		availability: "unsupported",
		disabled: true,
		hidden: true,
		label: ""
	});
	#props = { ...CastButtonCore.defaultProps };
	#media = null;
	constructor(props) {
		if (props) this.setProps(props);
	}
	setProps(props) {
		this.#props = defaults(props, CastButtonCore.defaultProps);
	}
	getLabel(state) {
		const label = resolveLabel(this.#props.label, state);
		if (label) return label;
		if (state.connection === "connected") return stopText;
		if (state.connection === "connecting") return connectingText;
		return startText;
	}
	getAttrs(state) {
		return {
			"aria-label": this.getLabel(state),
			"aria-disabled": state.disabled ? "true" : void 0,
			hidden: state.hidden ? "" : void 0
		};
	}
	setMedia(media) {
		this.#media = media;
	}
	getState() {
		const media = this.#media;
		const availability = !!globalThis.chrome ? media.remotePlaybackAvailability : "unsupported";
		this.state.patch({
			connection: media.remotePlaybackState,
			availability,
			disabled: this.#props.disabled || availability !== "available",
			hidden: availability === "unsupported"
		});
		this.state.patch({ label: resolveText(this.getLabel(this.state.current)) });
		return this.state.current;
	}
	async toggle(media) {
		this.setMedia(media);
		if (this.getState().disabled) return;
		return media.toggleRemotePlayback();
	}
};

//#endregion
//#region ../core/dist/default/core/ui/cast-button/cast-button-data-attrs.js
const CastButtonDataAttrs = {
	/**
	* Current remote playback connection state.
	*
	* @see https://developer.mozilla.org/en-US/docs/Web/API/RemotePlayback/state
	*/
	connection: "data-cast-state",
	/**
	* Whether remote playback can be requested on this platform.
	*
	* @see https://developer.mozilla.org/en-US/docs/Web/API/RemotePlayback
	*/
	availability: "data-availability",
	/** Present when the button is non-interactive (mirrors `aria-disabled`). */
	disabled: "data-disabled",
	/** Present when the button is hidden because the feature is unsupported. */
	hidden: "data-hidden"
};

//#endregion
//#region ../core/dist/default/core/ui/controls/controls-core.js
var ControlsCore = class {
	#media = null;
	setMedia(media) {
		this.#media = media;
	}
	getState() {
		const media = this.#media;
		return {
			visible: media.controlsVisible,
			userActive: media.userActive
		};
	}
};

//#endregion
//#region ../core/dist/default/core/ui/controls/controls-data-attrs.js
const ControlsDataAttrs = {
	/** Present when controls are visible. */
	visible: "data-visible",
	/** Present when the user has recently interacted. */
	userActive: "data-user-active"
};

//#endregion
//#region ../core/dist/default/core/ui/error-dialog/error-dialog-core.js
/** Error-dialog core: an alert dialog whose open state is driven by media error state. */
var ErrorDialogCore = class extends AlertDialogCore {
	setProps() {}
};

//#endregion
//#region ../core/dist/default/i18n/text/common.js
const prefix$9 = "common.";
const emptyText = {
	key: `${prefix$9}empty`,
	text: ""
};
const okText = {
	key: `${prefix$9}ok`,
	text: "OK"
};

//#endregion
//#region ../core/dist/default/i18n/text/errors.js
const prefix$8 = "errors.";
const abortedText = {
	key: `${prefix$8}aborted`,
	text: "You stopped media playback before it finished."
};
const networkText = {
	key: `${prefix$8}network`,
	text: "This media could not be loaded due to a network or server issue."
};
const decodeText = {
	key: `${prefix$8}decode`,
	text: "This media could not be played. It may be corrupted, or your browser may not support its format."
};
const sourceText = {
	key: `${prefix$8}source`,
	text: "This media could not be loaded. It may be unavailable, or your browser may not support its format."
};
const encryptedText = {
	key: `${prefix$8}encrypted`,
	text: "This media could not be played because it could not be decrypted."
};
const unplayableText = {
	key: `${prefix$8}unplayable`,
	text: "This media is unsupported by the player."
};
const titleText = {
	key: `${prefix$8}title`,
	text: "Something went wrong."
};
const unexpectedText = {
	key: `${prefix$8}unexpected`,
	text: "An unexpected error occurred."
};

//#endregion
//#region ../core/dist/default/core/ui/error-dialog/error-dialog-i18n.js
/**
* SVTA 99 [Custom] 001 — an engine reporting that it has no pipeline for
* something the source requires. Not a `MediaError.MEDIA_ERR_*` value: engines
* that report SVTA codes surface them on `error.code` directly.
*
* The literal rather than an import. `@videojs/spf` defines this as
* `SVTA_UNSUPPORTED_PLAYBACK_FEATURE` and owns its meaning, but core doesn't
* depend on spf, and reaching it through `@videojs/media` would pull an engine
* entry point into a barrel that has no other reason to load one. Same trade
* `HlsVideoMediaStreamType` makes in the other direction — compatibility by
* value, stated in a comment, instead of a dependency edge neither package
* wants.
*/
const SVTA_UNSUPPORTED_PLAYBACK_FEATURE = 99001;
const MEDIA_ERROR_TRANSLATIONS = {
	[MediaError.MEDIA_ERR_ABORTED]: abortedText,
	[MediaError.MEDIA_ERR_NETWORK]: networkText,
	[MediaError.MEDIA_ERR_DECODE]: decodeText,
	[MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED]: sourceText,
	[MediaError.MEDIA_ERR_ENCRYPTED]: encryptedText,
	[MediaError.MEDIA_ERR_CUSTOM]: emptyText,
	[SVTA_UNSUPPORTED_PLAYBACK_FEATURE]: unplayableText
};
const STANDARD_CODE_UA_MESSAGES = { [MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED]: ["Failed to open media"] };
function isStandardMediaErrorCode(code) {
	return code >= MediaError.MEDIA_ERR_ABORTED && code <= MediaError.MEDIA_ERR_ENCRYPTED;
}
function getErrorDialogTitleText() {
	return titleText;
}
function getErrorDialogDismissText() {
	return okText;
}
function getErrorDialogUnexpectedText() {
	return unexpectedText;
}
/**
* Resolves dialog body copy: default phrases for known {@link MediaError} defaults, literal text for
* custom messages, otherwise the generic fallback key.
*/
function resolveErrorDialogDescription(error, cachedMessage) {
	if (error) {
		const text = MEDIA_ERROR_TRANSLATIONS[error.code];
		const message = error.message?.trim();
		if (message) {
			const defaultForCode = MediaError.defaultMessages[error.code];
			if (text && defaultForCode && message === defaultForCode) return text;
			const uaVariants = STANDARD_CODE_UA_MESSAGES[error.code];
			if (text && isStandardMediaErrorCode(error.code) && !error.context && uaVariants?.includes(message)) return text;
			return message;
		}
		if (text) return text;
	}
	const cached = cachedMessage?.trim();
	if (cached) return cached;
	return unexpectedText;
}

//#endregion
//#region ../core/dist/default/i18n/text/fullscreen.js
const prefix$7 = "fullscreen.";
const enterText$1 = {
	key: `${prefix$7}enter`,
	text: "Enter fullscreen"
};
const exitText$1 = {
	key: `${prefix$7}exit`,
	text: "Exit fullscreen"
};

//#endregion
//#region ../core/dist/default/core/ui/fullscreen-button/fullscreen-button-core.js
var FullscreenButtonCore = class FullscreenButtonCore {
	static defaultProps = {
		label: "",
		disabled: false
	};
	state = createState({
		fullscreen: false,
		availability: "unavailable",
		disabled: true,
		hidden: true,
		label: ""
	});
	#props = { ...FullscreenButtonCore.defaultProps };
	#media = null;
	constructor(props) {
		if (props) this.setProps(props);
	}
	setProps(props) {
		this.#props = defaults(props, FullscreenButtonCore.defaultProps);
	}
	getLabel(state) {
		const label = resolveLabel(this.#props.label, state);
		if (label) return label;
		return state.fullscreen ? exitText$1 : enterText$1;
	}
	getAttrs(state) {
		return {
			"aria-label": this.getLabel(state),
			"aria-disabled": state.disabled ? "true" : void 0,
			hidden: state.hidden ? "" : void 0
		};
	}
	setMedia(media) {
		this.#media = media;
	}
	getState() {
		const media = this.#media;
		const availability = media.fullscreenAvailability;
		this.state.patch({
			fullscreen: media.fullscreen,
			availability,
			disabled: this.#props.disabled || availability !== "available",
			hidden: availability !== "available"
		});
		this.state.patch({ label: resolveText(this.getLabel(this.state.current)) });
		return this.state.current;
	}
	async toggle(media) {
		this.setMedia(media);
		if (this.getState().disabled) return;
		return media.fullscreen ? media.exitFullscreen() : media.requestFullscreen();
	}
};

//#endregion
//#region ../core/dist/default/core/ui/fullscreen-button/fullscreen-button-data-attrs.js
const FullscreenButtonDataAttrs = {
	/** Present when fullscreen mode is active. */
	fullscreen: "data-fullscreen",
	/** Indicates fullscreen availability (`available`, `unavailable`, `unsupported`). */
	availability: "data-availability",
	/** Present when the button is non-interactive (mirrors `aria-disabled`). */
	disabled: "data-disabled",
	/** Present when the button is hidden because fullscreen is not available. */
	hidden: "data-hidden"
};

//#endregion
//#region ../core/dist/default/i18n/text/status.js
const prefix$6 = "status.";
const captionsOnText = {
	key: `${prefix$6}captionsOn`,
	text: "Captions on"
};
const captionsOffText = {
	key: `${prefix$6}captionsOff`,
	text: "Captions off"
};
const pausedText = {
	key: `${prefix$6}paused`,
	text: "Paused"
};
const playingText$1 = {
	key: `${prefix$6}playing`,
	text: "Playing"
};
const fullscreenText = {
	key: `${prefix$6}fullscreen`,
	text: "Fullscreen"
};
const pipText = {
	key: `${prefix$6}pip`,
	text: "Picture in picture"
};
const exitPipText = {
	key: `${prefix$6}exitPip`,
	text: "Exit picture in picture"
};
const seekedToText = {
	key: `${prefix$6}seekedTo`,
	text: "Seeked to {time}"
};

//#endregion
//#region ../core/dist/default/i18n/text/volume.js
const prefix$5 = "volume.";
const mutedValueText = {
	key: `${prefix$5}mutedValue`,
	text: "{percent}, muted"
};
const mutedText = {
	key: `${prefix$5}muted`,
	text: "Muted"
};
const labelText = {
	key: `${prefix$5}label`,
	text: "Volume"
};
const valueText = {
	key: `${prefix$5}value`,
	text: "Volume {value}"
};

//#endregion
//#region ../core/dist/default/core/ui/indicator/indicator-labels.js
const DEFAULT_INPUT_INDICATOR_LABELS = {
	muted: translateText(mutedText),
	volume: translateText(labelText),
	captionsOn: translateText(captionsOnText),
	captionsOff: translateText(captionsOffText),
	paused: translateText(pausedText),
	playing: translateText(playingText$1),
	fullscreen: translateText(fullscreenText),
	exitFullscreen: translateText(exitText$1),
	pictureInPicture: translateText(pipText),
	exitPictureInPicture: translateText(exitPipText)
};
/** Maps i18n indicator keys to {@link InputIndicatorLabels} for status / volume feedback. */
function createInputIndicatorLabels(translator) {
	return {
		muted: translator(mutedText),
		volume: translator(labelText),
		captionsOn: translator(captionsOnText),
		captionsOff: translator(captionsOffText),
		paused: translator(pausedText),
		playing: translator(playingText$1),
		fullscreen: translator(fullscreenText),
		exitFullscreen: translator(exitText$1),
		pictureInPicture: translator(pipText),
		exitPictureInPicture: translator(exitPipText)
	};
}

//#endregion
//#region ../core/dist/default/core/ui/input-action/input-action.js
function isInputActionIncluded(action, actions) {
	if (!action) return false;
	return !actions || actions.includes(action);
}

//#endregion
//#region ../core/dist/default/i18n/text/live.js
const prefix$4 = "live.";
const playingText = {
	key: `${prefix$4}playing`,
	text: "Playing live"
};
const seekToEdgeText = {
	key: `${prefix$4}seekToEdge`,
	text: "Seek to live edge"
};
const badgeText = {
	key: `${prefix$4}badge`,
	text: "Live"
};

//#endregion
//#region ../core/dist/default/core/ui/live-button/live-button-core.js
/**
* Fallback offset (in seconds) from the end of the seekable window used to
* decide "at live edge" when `liveEdgeStart` is unavailable.
*/
const LIVE_EDGE_OFFSET = 10;
/**
* Grace window (in seconds) before `liveEdgeStart` that still counts as
* "at the live edge". Absorbs the small gap between the player's initial
* playback position (e.g. hls.js `liveSyncDuration`) and the manifest's
* `HOLD-BACK`, so autoplay reliably reports live.
*/
const LIVE_EDGE_TOLERANCE = 5;
/**
* Core state machine for a "Live" button. Indicates whether the player is
* playing at the live edge and seeks to the Seekable Live Edge when activated.
*
* @see https://github.com/video-dev/media-ui-extensions/blob/main/proposals/0007-live-edge.md
*/
var LiveButtonCore = class LiveButtonCore {
	/** Default visible text used when no children are provided. */
	static defaultText = badgeText;
	static defaultProps = {
		label: "",
		disabled: false
	};
	state = createState({
		live: false,
		liveEdge: false,
		label: ""
	});
	#props = { ...LiveButtonCore.defaultProps };
	#media = null;
	constructor(props) {
		if (props) this.setProps(props);
	}
	setProps(props) {
		this.#props = defaults(props, LiveButtonCore.defaultProps);
	}
	getLabel(state) {
		const label = resolveLabel(this.#props.label, state);
		if (label) return label;
		if (state.liveEdge) return playingText;
		return seekToEdgeText;
	}
	getAttrs(state) {
		const inactive = this.#props.disabled || state.liveEdge;
		return {
			"aria-label": this.getLabel(state),
			"aria-disabled": inactive ? "true" : void 0
		};
	}
	setMedia(media) {
		this.#media = media;
	}
	getState() {
		const media = this.#media;
		const live = isLiveMedia(media);
		const liveEdge = live && this.#isAtLiveEdge(media);
		this.state.patch({
			live,
			liveEdge
		});
		this.state.patch({ label: resolveText(this.getLabel(this.state.current)) });
		return this.state.current;
	}
	/** Seek to the Seekable Live Edge. No-op when not live or already at edge. */
	async seekToLive(media) {
		if (this.#props.disabled) return;
		if (!isLiveMedia(media)) return;
		if (this.#isAtLiveEdge(media)) return;
		const target = liveEdgeTarget(media);
		if (target == null) return;
		await media.seek(target);
	}
	#isAtLiveEdge(media) {
		const { currentTime, liveEdgeStart } = media;
		if (Number.isFinite(liveEdgeStart)) return currentTime >= liveEdgeStart - LIVE_EDGE_TOLERANCE;
		const target = liveEdgeTarget(media);
		if (target == null) return false;
		return currentTime >= target - LIVE_EDGE_OFFSET;
	}
};
function isLiveMedia(media) {
	return !Number.isNaN(media.targetLiveWindow);
}
function liveEdgeTarget(media) {
	const { seekable } = media;
	if (seekable.length === 0) return null;
	const end = seekable[seekable.length - 1][1];
	return Number.isFinite(end) ? end : null;
}

//#endregion
//#region ../core/dist/default/core/ui/live-button/live-button-data-attrs.js
const LiveButtonDataAttrs = {
	/** Present when the stream is live (or DVR). */
	live: "data-live",
	/** Present when playback is at the live edge. */
	liveEdge: "data-live-edge"
};

//#endregion
//#region ../core/dist/default/core/ui/menu/menu-core.js
/** Base menu logic: ARIA attributes and open/close state computation. */
var MenuCore = class MenuCore {
	static defaultProps = {
		side: "bottom",
		align: "start",
		open: false,
		defaultOpen: false,
		closeOnEscape: true,
		closeOnOutsideClick: true,
		isSubmenu: false
	};
	#props = { ...MenuCore.defaultProps };
	#input = null;
	get props() {
		return this.#props;
	}
	constructor(props) {
		if (props) this.setProps(props);
	}
	setProps(props) {
		this.#props = defaults(props, MenuCore.defaultProps);
	}
	setInput(input) {
		this.#input = input;
	}
	getState() {
		const input = this.#input;
		const isSubmenu = this.#props.isSubmenu;
		return {
			open: input.active,
			status: input.status,
			side: isSubmenu ? void 0 : this.#props.side,
			align: isSubmenu ? void 0 : this.#props.align,
			isSubmenu,
			...getTransitionFlags(input.status)
		};
	}
	getTriggerAttrs(state, contentId) {
		return {
			"aria-haspopup": "menu",
			"aria-expanded": state.open && state.status !== "ending" ? "true" : "false",
			"aria-controls": contentId
		};
	}
	getContentAttrs(state) {
		return {
			role: "menu",
			tabIndex: -1,
			...!state.isSubmenu && { popover: "manual" }
		};
	}
};

//#endregion
//#region ../core/dist/default/core/ui/menu/menu-data-attrs.js
/** Data attributes set on the menu Content element and inherited by all children. */
const MenuDataAttrs = {
	/** Present when the menu is open. */
	open: "data-open",
	/** Rendered positioning side after collision handling. Absent on submenus. */
	side: "data-side",
	/** Popover positioning alignment. Absent on submenus. */
	align: "data-align",
	/** Present on Content when this menu is nested inside a parent menu. */
	isSubmenu: "data-submenu",
	...TransitionDataAttrs
};

//#endregion
//#region ../core/dist/default/i18n/text/buttons.js
const prefix$3 = "buttons.";
const playText = {
	key: `${prefix$3}play`,
	text: "Play"
};
const pauseText = {
	key: `${prefix$3}pause`,
	text: "Pause"
};
const replayText = {
	key: `${prefix$3}replay`,
	text: "Replay"
};
const muteText = {
	key: `${prefix$3}mute`,
	text: "Mute"
};
const unmuteText = {
	key: `${prefix$3}unmute`,
	text: "Unmute"
};

//#endregion
//#region ../core/dist/default/core/ui/mute-button/mute-button-core.js
var MuteButtonCore = class MuteButtonCore {
	static defaultProps = {
		label: "",
		disabled: false
	};
	state = createState({
		muted: false,
		volumeLevel: "off",
		availability: "unavailable",
		hidden: true,
		label: ""
	});
	#props = { ...MuteButtonCore.defaultProps };
	#media = null;
	constructor(props) {
		if (props) this.setProps(props);
	}
	setProps(props) {
		this.#props = defaults(props, MuteButtonCore.defaultProps);
	}
	getLabel(state) {
		const label = resolveLabel(this.#props.label, state);
		if (label) return label;
		return state.muted ? unmuteText : muteText;
	}
	getAttrs(state) {
		return {
			"aria-label": this.getLabel(state),
			"aria-disabled": this.#props.disabled ? "true" : void 0
		};
	}
	setMedia(media) {
		this.#media = media;
	}
	getState() {
		const media = this.#media;
		const availability = media.mutedAvailability;
		this.state.patch({
			muted: media.muted || media.volume === 0,
			volumeLevel: getVolumeLevel$1(media),
			availability,
			hidden: availability !== "available"
		});
		this.state.patch({ label: resolveText(this.getLabel(this.state.current)) });
		return this.state.current;
	}
	toggle(media) {
		if (this.#props.disabled || media.mutedAvailability !== "available") return;
		media.toggleMuted();
	}
};
function getVolumeLevel$1(media) {
	if (media.muted || media.volume === 0) return "off";
	if (media.volume < .5) return "low";
	if (media.volume < .75) return "medium";
	return "high";
}

//#endregion
//#region ../core/dist/default/core/ui/mute-button/mute-button-data-attrs.js
const MuteButtonDataAttrs = {
	/** Present when the media is muted. */
	muted: "data-muted",
	/** Indicates the volume level. */
	volumeLevel: "data-volume-level",
	/** Indicates mute availability (`available`, `unavailable`, `unsupported`). */
	availability: "data-availability",
	/** Present when the button is hidden because the media has no mute to toggle. */
	hidden: "data-hidden"
};

//#endregion
//#region ../core/dist/default/i18n/text/pip.js
const prefix$2 = "pip.";
const enterText = {
	key: `${prefix$2}enter`,
	text: "Enter picture-in-picture"
};
const exitText = {
	key: `${prefix$2}exit`,
	text: "Exit picture-in-picture"
};

//#endregion
//#region ../core/dist/default/core/ui/pip-button/pip-button-core.js
var PiPButtonCore = class PiPButtonCore {
	static defaultProps = {
		label: "",
		disabled: false
	};
	state = createState({
		pip: false,
		availability: "unavailable",
		disabled: true,
		hidden: true,
		label: ""
	});
	#props = { ...PiPButtonCore.defaultProps };
	#media = null;
	constructor(props) {
		if (props) this.setProps(props);
	}
	setProps(props) {
		this.#props = defaults(props, PiPButtonCore.defaultProps);
	}
	getLabel(state) {
		const label = resolveLabel(this.#props.label, state);
		if (label) return label;
		return state.pip ? exitText : enterText;
	}
	getAttrs(state) {
		return {
			"aria-label": this.getLabel(state),
			"aria-disabled": state.disabled ? "true" : void 0,
			hidden: state.hidden ? "" : void 0
		};
	}
	setMedia(media) {
		this.#media = media;
	}
	getState() {
		const media = this.#media;
		const availability = media.pipAvailability;
		this.state.patch({
			pip: media.pip,
			availability,
			disabled: this.#props.disabled || availability !== "available",
			hidden: availability !== "available"
		});
		this.state.patch({ label: resolveText(this.getLabel(this.state.current)) });
		return this.state.current;
	}
	async toggle(media) {
		this.setMedia(media);
		if (this.getState().disabled) return;
		return media.pip ? media.exitPictureInPicture() : media.requestPictureInPicture();
	}
};

//#endregion
//#region ../core/dist/default/core/ui/pip-button/pip-button-data-attrs.js
const PiPButtonDataAttrs = {
	/** Present when picture-in-picture mode is active. */
	pip: "data-pip",
	/** Indicates picture-in-picture availability (`available`, `unavailable`, `unsupported`). */
	availability: "data-availability",
	/** Present when the button is non-interactive (mirrors `aria-disabled`). */
	disabled: "data-disabled",
	/** Present when the button is hidden because picture-in-picture is not available. */
	hidden: "data-hidden"
};

//#endregion
//#region ../core/dist/default/core/ui/play-button/play-button-core.js
var PlayButtonCore = class PlayButtonCore {
	static defaultProps = {
		label: "",
		disabled: false
	};
	state = createState({
		paused: true,
		ended: false,
		started: false,
		label: ""
	});
	#props = { ...PlayButtonCore.defaultProps };
	#media = null;
	constructor(props) {
		if (props) this.setProps(props);
	}
	setProps(props) {
		this.#props = defaults(props, PlayButtonCore.defaultProps);
	}
	getLabel(state) {
		const label = resolveLabel(this.#props.label, state);
		if (label) return label;
		if (state.ended) return replayText;
		return state.paused ? playText : pauseText;
	}
	getAttrs(state) {
		return {
			"aria-label": this.getLabel(state),
			"aria-disabled": this.#props.disabled ? "true" : void 0
		};
	}
	setMedia(media) {
		this.#media = media;
	}
	getState() {
		const media = this.#media;
		this.state.patch({
			paused: media.paused,
			ended: media.ended,
			started: media.started
		});
		this.state.patch({ label: resolveText(this.getLabel(this.state.current)) });
		return this.state.current;
	}
	async toggle(media) {
		if (this.#props.disabled) return;
		if (media.paused || media.ended) return media.play();
		media.pause();
	}
};

//#endregion
//#region ../core/dist/default/core/ui/play-button/play-button-data-attrs.js
const PlayButtonDataAttrs = {
	/** Present when the media is paused. */
	paused: "data-paused",
	/** Present when the media has ended. */
	ended: "data-ended",
	/** Present when playback has started. */
	started: "data-started"
};

//#endregion
//#region ../core/dist/default/i18n/text/playback.js
const rateText = {
	key: `playback.rate`,
	text: "Playback rate {rate}"
};

//#endregion
//#region ../core/dist/default/core/ui/playback-rate-button/playback-rate-button-core.js
var PlaybackRateButtonCore = class PlaybackRateButtonCore {
	static defaultProps = {
		label: "",
		disabled: false,
		menuTrigger: false
	};
	state = createState({
		rate: 1,
		label: ""
	});
	#props = { ...PlaybackRateButtonCore.defaultProps };
	#media = null;
	constructor(props) {
		if (props) this.setProps(props);
	}
	setProps(props) {
		this.#props = defaults(props, PlaybackRateButtonCore.defaultProps);
	}
	getLabel(state) {
		const custom = resolveLabel(this.#props.label, state);
		if (custom !== void 0) return custom;
		return rateText;
	}
	getLabelParams(state) {
		if (resolveLabel(this.#props.label, state) !== void 0) return void 0;
		return { rate: state.rate };
	}
	getAttrs(state) {
		return {
			"aria-label": this.getLabel(state),
			"aria-disabled": this.#props.disabled ? "true" : void 0
		};
	}
	setMedia(media) {
		this.#media = media;
	}
	getState() {
		const media = this.#media;
		this.state.patch({ rate: media.playbackRate });
		this.state.patch({ label: resolveText(this.getLabel(this.state.current)) });
		return this.state.current;
	}
	cycle(media) {
		if (this.#props.disabled) return;
		if (this.#props.menuTrigger) return;
		const { playbackRates, playbackRate } = media;
		if (playbackRates.length === 0) return;
		const idx = playbackRates.indexOf(playbackRate);
		const next = idx === -1 ? playbackRates.find((r) => r > playbackRate) ?? playbackRates[0] : playbackRates[(idx + 1) % playbackRates.length];
		media.setPlaybackRate(next);
	}
};

//#endregion
//#region ../core/dist/default/core/ui/playback-rate-button/playback-rate-button-data-attrs.js
const PlaybackRateButtonDataAttrs = { 
/** Current playback rate. */
rate: "data-rate" };

//#endregion
//#region ../core/dist/default/core/ui/playback-rate-radio-group/playback-rate-radio-group-core.js
function formatPlaybackRate(rate) {
	return `${rate}×`;
}
var PlaybackRateRadioGroupCore = class PlaybackRateRadioGroupCore {
	static defaultProps = {
		label: "",
		formatRate: formatPlaybackRate,
		disabled: false
	};
	state = createState({
		rate: 1,
		value: "1",
		options: [],
		disabled: true,
		hidden: true,
		availability: "unavailable",
		label: ""
	});
	#props = { ...PlaybackRateRadioGroupCore.defaultProps };
	#media = null;
	constructor(props) {
		if (props) this.setProps(props);
	}
	setProps(props) {
		this.#props = defaults(props, PlaybackRateRadioGroupCore.defaultProps);
	}
	getLabel(state) {
		const custom = resolveLabel(this.#props.label, state);
		if (custom !== void 0) return custom;
		return playbackRateText;
	}
	getLabelParams(_state) {}
	getRateLabel(rate) {
		return this.#props.formatRate(rate);
	}
	getRateValue(rate) {
		return String(rate);
	}
	getAttrs(state) {
		return {
			"aria-label": this.getLabel(state),
			"aria-disabled": state.disabled ? "true" : void 0,
			hidden: state.hidden ? "" : void 0
		};
	}
	setMedia(media) {
		this.#media = media;
	}
	getState() {
		const media = this.#media;
		const availability = media.playbackRates.length > 0 ? "available" : "unavailable";
		this.state.patch({
			rate: media.playbackRate,
			value: this.getRateValue(media.playbackRate),
			options: media.playbackRates.map((rate) => ({
				rate,
				value: this.getRateValue(rate),
				label: this.getRateLabel(rate),
				disabled: false
			})),
			disabled: this.#props.disabled || media.playbackRates.length === 0,
			hidden: availability === "unavailable",
			availability
		});
		this.state.patch({ label: resolveText(this.getLabel(this.state.current)) });
		return this.state.current;
	}
	select(media, rate) {
		if (this.#props.disabled) return;
		if (!media.playbackRates.includes(rate)) return;
		media.setPlaybackRate(rate);
	}
	selectValue(media, value) {
		const rate = media.playbackRates.find((candidate) => this.getRateValue(candidate) === value);
		if (isUndefined(rate)) return;
		this.select(media, rate);
	}
};

//#endregion
//#region ../core/dist/default/core/ui/playback-rate-radio-group/playback-rate-radio-group-data-attrs.js
const PlaybackRateRadioGroupDataAttrs = {
	/** Current playback rate. */
	rate: "data-rate",
	/** Present when playback rate selection is disabled. */
	disabled: "data-disabled",
	/** Present when playback rate selection is unavailable. */
	hidden: "data-hidden",
	/** Indicates playback rate availability (`available` or `unavailable`). */
	availability: "data-availability"
};

//#endregion
//#region ../core/dist/default/core/ui/popover/popover-core.js
var PopoverCore = class PopoverCore {
	static defaultProps = {
		side: "top",
		align: "center",
		modal: false,
		closeOnEscape: true,
		closeOnOutsideClick: true,
		open: false,
		defaultOpen: false,
		openOnHover: false,
		delay: 300,
		closeDelay: 0
	};
	#props = { ...PopoverCore.defaultProps };
	constructor(props) {
		if (props) this.setProps(props);
	}
	setProps(props) {
		this.#props = defaults(props, PopoverCore.defaultProps);
	}
	#input = null;
	setInput(input) {
		this.#input = input;
	}
	getState() {
		const input = this.#input;
		return {
			open: input.active,
			status: input.status,
			side: this.#props.side,
			align: this.#props.align,
			modal: this.#props.modal,
			...getTransitionFlags(input.status)
		};
	}
	getTriggerAttrs(state, popupId) {
		return {
			"aria-expanded": state.open && state.status !== "ending" ? "true" : "false",
			"aria-haspopup": "dialog",
			"aria-controls": popupId
		};
	}
	getPopupAttrs(state) {
		return {
			popover: "manual",
			role: "dialog",
			"aria-modal": state.modal === true ? "true" : void 0
		};
	}
};

//#endregion
//#region ../core/dist/default/core/ui/popover/popover-data-attrs.js
const PopoverDataAttrs = {
	/** Present when the popover is open. */
	open: "data-open",
	/** Indicates the rendered side of the popover after collision handling. */
	side: "data-side",
	/** Indicates how the popover is aligned relative to the specified side. */
	align: "data-align",
	...TransitionDataAttrs
};

//#endregion
//#region ../core/dist/default/core/ui/popover/popup-host-attr.js
/**
* Hosted floating UI surfaces (popover, menu, tooltip, and future overlays) that support
* parent-driven lifecycle may set {@link POPUP_HOST_ATTR}. Ancestors can discover them with
* {@link POPUP_HOST_SELECTOR} and call methods such as `close('imperative-action')` when
* the element implements that contract.
*/
const POPUP_HOST_ATTR = "data-popup";
const POPUP_HOST_SELECTOR = `[${POPUP_HOST_ATTR}]`;

//#endregion
//#region ../core/dist/default/core/ui/poster/poster-core.js
var PosterCore = class {
	#media = null;
	setMedia(media) {
		this.#media = media;
	}
	getState() {
		return { visible: !this.#media.started };
	}
};

//#endregion
//#region ../core/dist/default/core/ui/poster/poster-data-attrs.js
const PosterDataAttrs = { visible: "data-visible" };

//#endregion
//#region ../core/dist/default/core/ui/quality-radio-group/quality-radio-group-core.js
const QUALITY_AUTO_VALUE = "auto";
const STANDARD_RENDITION_SIZES = [
	4320,
	2160,
	1440,
	1080,
	720,
	480,
	360,
	240
];
function formatBitrate(bitrate) {
	return bitrate >= 1e6 ? `${Math.round(bitrate / 1e5) / 10} Mbps` : `${Math.round(bitrate / 1e3)} kbps`;
}
function getWidescreenSize(width) {
	const size = Math.round(width * 9 / 16);
	return STANDARD_RENDITION_SIZES.includes(size) ? size : void 0;
}
function getRenditionSize(rendition) {
	const { width, height } = rendition;
	if (width && height) {
		if (width > height && width * 9 > height * 16) return getWidescreenSize(width) ?? height;
		return Math.min(width, height);
	}
	if (height) return height;
	if (width) return getWidescreenSize(width) ?? width;
}
function hasSameSize(rendition, renditions) {
	const size = getRenditionSize(rendition);
	return Boolean(size && renditions.some((other) => other !== rendition && getRenditionSize(other) === size));
}
function formatRenditionLabel(rendition) {
	const size = getRenditionSize(rendition);
	if (size) return `${size}p`;
	if (rendition.bitrate) return formatBitrate(rendition.bitrate);
	return qualityText;
}
function formatRenditionBadge(rendition, renditions = []) {
	if (!getRenditionSize(rendition) || !rendition.bitrate || !hasSameSize(rendition, renditions)) return void 0;
	return formatBitrate(rendition.bitrate);
}
function formatRenditionTier(rendition) {
	const size = getRenditionSize(rendition);
	if (!size) return void 0;
	if (size >= 4320) return "8K";
	if (size >= 2160) return "4K";
	if (size >= 1080) return "HD";
}
function getRenditionValue(rendition, index) {
	return rendition.id || String(index);
}
function isSameRendition(a, b) {
	if (a.id !== void 0 || b.id !== void 0) return a.id === b.id;
	return a.width === b.width && a.height === b.height && a.bitrate === b.bitrate && a.frameRate === b.frameRate && a.codec === b.codec;
}
var QualityRadioGroupCore = class QualityRadioGroupCore {
	static defaultProps = {
		label: "",
		formatRendition: formatRenditionLabel,
		disabled: false
	};
	state = createState({
		options: [{
			value: QUALITY_AUTO_VALUE,
			label: autoText,
			disabled: false
		}],
		value: QUALITY_AUTO_VALUE,
		disabled: true,
		hidden: true,
		availability: "unavailable",
		label: ""
	});
	#props = { ...QualityRadioGroupCore.defaultProps };
	#media = null;
	constructor(props) {
		if (props) this.setProps(props);
	}
	setProps(props) {
		this.#props = defaults(props, QualityRadioGroupCore.defaultProps);
	}
	getLabel(state) {
		const label = resolveLabel(this.#props.label, state);
		if (label) return label;
		return qualityText;
	}
	getRenditionLabel(rendition) {
		if (this.#props.formatRendition !== QualityRadioGroupCore.defaultProps.formatRendition) return this.#props.formatRendition(rendition);
		return formatRenditionLabel(rendition);
	}
	getRenditionBadge(rendition, renditions = []) {
		if (this.#props.formatRendition !== QualityRadioGroupCore.defaultProps.formatRendition) return void 0;
		return formatRenditionBadge(rendition, renditions);
	}
	getRenditionTier(rendition) {
		if (this.#props.formatRendition !== QualityRadioGroupCore.defaultProps.formatRendition) return void 0;
		return formatRenditionTier(rendition);
	}
	getRenditionValue(rendition, index) {
		return getRenditionValue(rendition, index);
	}
	getAttrs(state) {
		return {
			"aria-label": this.getLabel(state),
			"aria-disabled": state.disabled ? "true" : void 0,
			hidden: state.hidden ? "" : void 0
		};
	}
	setMedia(media) {
		this.#media = media;
	}
	getState() {
		const media = this.#media;
		const selectedIndex = media.videoRenditionList.findIndex((rendition) => rendition.selected);
		const availability = media.videoRenditionList.length > 1 ? "available" : "unavailable";
		const toOption = (rendition, index) => {
			const tier = this.getRenditionTier(rendition);
			const badge = this.getRenditionBadge(rendition, media.videoRenditionList);
			return {
				value: this.getRenditionValue(rendition, index),
				label: this.getRenditionLabel(rendition),
				disabled: false,
				...tier && { tier },
				...badge && { badge }
			};
		};
		const activeIndex = media.activeVideoRendition === null ? -1 : media.videoRenditionList.findIndex((rendition) => isSameRendition(rendition, media.activeVideoRendition));
		const active = media.activeVideoRendition && activeIndex !== -1 ? toOption(media.activeVideoRendition, activeIndex) : void 0;
		const autoOption = {
			value: QUALITY_AUTO_VALUE,
			label: selectedIndex === -1 && active ? autoWithLabelText : autoText,
			disabled: false,
			...selectedIndex === -1 && active && { labelParams: { label: resolveText(active.label) } }
		};
		this.state.patch({
			options: [autoOption, ...media.videoRenditionList.map(toOption)],
			value: selectedIndex === -1 ? QUALITY_AUTO_VALUE : this.getRenditionValue(media.videoRenditionList[selectedIndex], selectedIndex),
			disabled: this.#props.disabled || availability === "unavailable",
			hidden: availability === "unavailable",
			availability
		});
		this.state.patch({ label: resolveText(this.getLabel(this.state.current)) });
		return this.state.current;
	}
	select(media, value) {
		if (this.#props.disabled) return;
		if (value === "auto") {
			media.selectVideoRendition(value);
			return;
		}
		if (!media.videoRenditionList.some((rendition, index) => this.getRenditionValue(rendition, index) === value)) return;
		media.selectVideoRendition(value);
	}
	selectValue(media, value) {
		this.select(media, value);
	}
};

//#endregion
//#region ../core/dist/default/core/ui/quality-radio-group/quality-radio-group-data-attrs.js
const QualityRadioGroupDataAttrs = {
	/** Current quality value. */
	value: "data-quality",
	/** Present when quality selection is disabled. */
	disabled: "data-disabled",
	/** Present when quality selection is unavailable. */
	hidden: "data-hidden",
	/** Indicates quality availability (`available` or `unavailable`). */
	availability: "data-availability"
};

//#endregion
//#region ../core/dist/default/i18n/text/seek.js
const prefix$1 = "seek.";
const forwardText = {
	key: `${prefix$1}forward`,
	text: "Seek forward {seconds} seconds"
};
const backwardText = {
	key: `${prefix$1}backward`,
	text: "Seek backward {seconds} seconds"
};

//#endregion
//#region ../core/dist/default/core/ui/seek-button/seek-button-core.js
var SeekButtonCore = class SeekButtonCore {
	static defaultProps = {
		seconds: 30,
		label: "",
		disabled: false
	};
	state = createState({
		seeking: false,
		direction: "forward",
		label: ""
	});
	#props = { ...SeekButtonCore.defaultProps };
	#media = null;
	constructor(props) {
		if (props) this.setProps(props);
	}
	setProps(props) {
		this.#props = defaults(props, SeekButtonCore.defaultProps);
	}
	getLabel(state) {
		const custom = resolveLabel(this.#props.label, state);
		if (custom !== void 0) return custom;
		return state.direction === "backward" ? backwardText : forwardText;
	}
	getLabelParams(state) {
		if (resolveLabel(this.#props.label, state) !== void 0) return void 0;
		return { seconds: Math.abs(this.#props.seconds) };
	}
	getAttrs(state) {
		return {
			"aria-label": this.getLabel(state),
			"aria-disabled": this.#props.disabled ? "true" : void 0
		};
	}
	setMedia(media) {
		this.#media = media;
	}
	getState() {
		const media = this.#media;
		const direction = this.#props.seconds < 0 ? "backward" : "forward";
		this.state.patch({
			seeking: media.seeking,
			direction
		});
		this.state.patch({ label: resolveText(this.getLabel(this.state.current)) });
		return this.state.current;
	}
	async seek(media) {
		if (this.#props.disabled) return;
		await media.seek(media.currentTime + this.#props.seconds);
	}
};

//#endregion
//#region ../core/dist/default/core/ui/seek-button/seek-button-data-attrs.js
const SeekButtonDataAttrs = {
	/** Present when a seek is in progress. */
	seeking: "data-seeking",
	/** Indicates the seek direction: `"forward"` or `"backward"`. */
	direction: "data-direction"
};

//#endregion
//#region ../utils/dist/time/format.js
const DurationFormat = Intl.DurationFormat;
const durationFormatters = /* @__PURE__ */ new Map();
/**
* `Intl.DurationFormat` is unavailable on Node < 23 (SSR/prerender) and pre-2024 evergreen
* browsers, so degrade gracefully per the documented browser-support fallback policy.
* Digital output stays exact; localized phrase styles fall back to English.
*/
function createFallbackFormatter(style, hoursDisplay, locale) {
	if (style === "digital") {
		const number = new Intl.NumberFormat(locale, { useGrouping: false });
		const padded = new Intl.NumberFormat(locale, {
			minimumIntegerDigits: 2,
			useGrouping: false
		});
		return { format: (duration) => {
			const body = `${padded.format(duration.minutes ?? 0)}:${padded.format(duration.seconds ?? 0)}`;
			return hoursDisplay === "always" || duration.hours !== void 0 ? `${number.format(duration.hours ?? 0)}:${body}` : body;
		} };
	}
	const units = [
		["hours", "hour"],
		["minutes", "minute"],
		["seconds", "second"]
	];
	return { format: (duration) => units.filter(([unit]) => duration[unit] !== void 0).map(([unit, label]) => {
		const value = duration[unit] ?? 0;
		return `${value} ${label}${value === 1 ? "" : "s"}`;
	}).join(", ") };
}
function localeCacheKey$1(locale) {
	if (locale === void 0) return "";
	return Array.isArray(locale) ? locale.join(":") : locale;
}
function isEnglishLocale(locale) {
	const tag = Array.isArray(locale) ? locale[0] : locale;
	if (!tag) return true;
	return tag === "en" || tag.startsWith(`en-`);
}
function getDurationFormatter(locale, style = "long", hoursDisplay, secondsDisplay) {
	const key = `${localeCacheKey$1(locale)}:${style}:${hoursDisplay ?? ""}:${secondsDisplay ?? ""}`;
	let formatter = durationFormatters.get(key);
	if (!formatter) {
		if (DurationFormat) {
			const options = { style };
			if (hoursDisplay !== void 0) options.hoursDisplay = hoursDisplay;
			if (secondsDisplay !== void 0) options.secondsDisplay = secondsDisplay;
			formatter = new DurationFormat(locale, options);
		} else formatter = createFallbackFormatter(style, hoursDisplay, locale);
		durationFormatters.set(key, formatter);
	}
	return formatter;
}
function isValidTime(value) {
	return isNumber(value) && Number.isFinite(value);
}
/**
* Format seconds to digital display string.
*
* @param seconds - Time in seconds (can be negative)
* @param guide - Guide time (typically duration) to determine display format
* @param options - Digital formatting options
* @returns Formatted string like "1:30" or "1:05:30"
*
* @example
* formatTime(90) // "1:30"
* formatTime(3661) // "1:01:01"
* formatTime(35, 3600) // "0:00:35" (guided by 1-hour duration)
* formatTime(35, 600) // "00:35" (guided by 10-minute duration)
*/
function formatTime$1(seconds, guide, options) {
	if (!isValidTime(seconds)) return "0:00";
	const negative = seconds < 0;
	const totalSeconds = Math.floor(Math.abs(seconds));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor(totalSeconds % 3600 / 60);
	const secondsPart = totalSeconds % 60;
	const guideSeconds = isValidTime(guide ?? 0) ? Math.abs(guide ?? 0) : 0;
	const guideHours = Math.floor(guideSeconds / 3600);
	const guideMinutes = Math.floor(guideSeconds / 60 % 60);
	const showHours = hours > 0 || guideHours > 0;
	const padMinutes = showHours || guideMinutes >= 10;
	const duration = showHours ? {
		hours,
		minutes,
		seconds: secondsPart
	} : {
		minutes,
		seconds: secondsPart
	};
	const { locale = "en" } = options ?? {};
	let body = getDurationFormatter(locale, "digital", showHours ? "always" : "auto").format(duration);
	if (!padMinutes) {
		const zero = new Intl.NumberFormat(locale, { useGrouping: false }).format(0);
		body = body.replace(new RegExp(`^${zero}(?=\\p{Nd}\\D)`, "u"), "");
	}
	return `${negative ? "-" : ""}${body}`;
}
/**
* Convert seconds to ISO 8601 duration for datetime attribute.
*
* @param seconds - Time in seconds
* @returns ISO 8601 duration string like "PT1M30S"
*
* @example
* secondsToIsoDuration(90) // "PT1M30S"
* secondsToIsoDuration(3661) // "PT1H1M1S"
*/
function secondsToIsoDuration(seconds) {
	if (!isValidTime(seconds)) return "PT0S";
	const positiveSeconds = Math.abs(seconds);
	const h = Math.floor(positiveSeconds / 3600);
	const m = Math.floor(positiveSeconds / 60 % 60);
	const s = Math.floor(positiveSeconds % 60);
	let duration = "PT";
	if (h > 0) duration += `${h}H`;
	if (m > 0) duration += `${m}M`;
	if (s > 0 || duration === "PT") duration += `${s}S`;
	return duration;
}
/**
* Human-readable duration using {@link Intl.DurationFormat}.
*
* Negative `seconds` denote remaining time: the absolute value is formatted, then wrapped in a
* localized phrase via {@link TimeFormatOptions.formatRemaining}; otherwise `{duration} remaining`.
*/
function formatTimeAsPhrase(seconds, options) {
	if (!isValidTime(seconds)) return "";
	const negative = seconds < 0;
	const totalSeconds = Math.floor(Math.abs(seconds));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor(totalSeconds % 3600 / 60);
	const secondsPart = totalSeconds % 60;
	const record = {};
	if (hours > 0) record.hours = hours;
	if (minutes > 0) record.minutes = minutes;
	if (secondsPart > 0 || hours === 0 && minutes === 0) record.seconds = secondsPart;
	const secondsDisplay = totalSeconds === 0 ? "always" : void 0;
	const body = getDurationFormatter(options?.locale, options?.style ?? "long", void 0, secondsDisplay).format(record);
	if (negative) {
		const formatRemaining = options?.formatRemaining;
		if (formatRemaining) return formatRemaining(body);
		if (isEnglishLocale(options?.locale)) return `${body} remaining`;
		return body;
	}
	return body;
}

//#endregion
//#region ../core/dist/default/core/ui/seek-indicator/seek-indicator-status.js
function isSeekIndicatorAction(action) {
	return action === "seekStep" || action === "seekToPercent";
}
function formatCurrentTime(snapshot) {
	return formatTime$1(snapshot.currentTime ?? 0, snapshot.duration);
}
function getSeekIndicatorDisplayValue(state) {
	return state.value ?? state.currentTime;
}
function getSeekToPercent(event) {
	if (event.value !== void 0) return clamp(event.value, 0, 100);
	if (!event.key || event.key < "0" || event.key > "9") return null;
	return Number(event.key) * 10;
}
function getSeekDirection(event, snapshot) {
	if (event.action === "seekStep" && event.value !== void 0) {
		if (event.value > 0) return "forward";
		if (event.value < 0) return "backward";
	}
	if (event.action === "seekToPercent") {
		const percent = getSeekToPercent(event);
		if (percent === null || snapshot.duration === void 0 || snapshot.duration <= 0) return null;
		const targetTime = percent / 100 * snapshot.duration;
		const currentTime = snapshot.currentTime ?? 0;
		if (targetTime > currentTime) return "forward";
		if (targetTime < currentTime) return "backward";
	}
	return null;
}

//#endregion
//#region ../core/dist/default/core/ui/seek-indicator/seek-indicator-core.js
const INITIAL_STATE$2 = {
	open: false,
	generation: 0,
	direction: null,
	count: 0,
	seekTotal: 0,
	value: null,
	currentTime: "0:00",
	transitionStarting: false,
	transitionEnding: false
};
var SeekIndicatorCore = class {
	state = createState({ ...INITIAL_STATE$2 });
	#props = {};
	#originTime = null;
	#close = new IndicatorCloseController(() => {
		this.#originTime = null;
		this.state.patch({
			open: false,
			direction: null,
			count: 0,
			seekTotal: 0,
			value: null
		});
	}, () => getIndicatorCloseDelay(this.#props));
	setProps(props) {
		this.#props = props;
	}
	destroy() {
		this.#close.destroy();
	}
	close() {
		this.#close.close();
	}
	processEvent(event, snapshot) {
		if (!isSeekIndicatorAction(event.action)) return false;
		const current = this.state.current;
		const direction = getSeekDirection(event, snapshot);
		const rapidRepeat = current.open && event.action === "seekStep" && current.direction === direction;
		if (!rapidRepeat) this.#originTime = snapshot.currentTime ?? null;
		const value = this.#getEffectiveSeekValue(event, snapshot, rapidRepeat);
		const seekTotal = rapidRepeat ? current.seekTotal + Math.abs(value) : Math.abs(value);
		this.state.patch({
			open: true,
			generation: current.generation + 1,
			direction,
			count: rapidRepeat ? current.count + 1 : 1,
			seekTotal,
			value: event.action === "seekStep" && seekTotal > 0 ? `${seekTotal}s` : null,
			currentTime: formatCurrentTime(snapshot)
		});
		this.#close.arm();
		return true;
	}
	#getEffectiveSeekValue(event, snapshot, rapidRepeat) {
		if (event.action !== "seekStep" || event.value === void 0) return 0;
		if (!rapidRepeat || this.#originTime === null) return event.value;
		const originTime = this.#originTime;
		const duration = snapshot.duration ?? Infinity;
		const currentTotal = this.state.current.seekTotal;
		const step = Math.abs(event.value);
		return (event.value < 0 ? Math.max(0, originTime - currentTotal) : Math.max(0, duration - originTime - currentTotal)) >= step ? event.value : 0;
	}
};

//#endregion
//#region ../core/dist/default/core/ui/seek-indicator/seek-indicator-data-attrs.js
const SeekIndicatorDataAttrs = {
	open: "data-open",
	direction: "data-direction",
	transitionStarting: "data-starting-style",
	transitionEnding: "data-ending-style"
};

//#endregion
//#region ../core/dist/default/core/ui/slider/slider-core.js
/** Base slider logic: value mapping, ARIA attrs, and step calculations. */
var SliderCore = class SliderCore {
	static defaultProps = {
		label: "",
		step: 1,
		largeStep: 10,
		orientation: "horizontal",
		disabled: false,
		thumbAlignment: "center",
		value: 0,
		min: 0,
		max: 100
	};
	static defaultInput = {
		pointerPercent: 0,
		dragPercent: 0,
		dragging: false,
		pointing: false,
		focused: false
	};
	#props = { ...SliderCore.defaultProps };
	#input = { ...SliderCore.defaultInput };
	get props() {
		return this.#props;
	}
	get input() {
		return this.#input;
	}
	constructor(props) {
		if (props) this.setProps(props);
	}
	setProps(props) {
		this.#props = defaults(props, SliderCore.defaultProps);
	}
	setInput(input) {
		this.#input = input;
	}
	getSliderState(value) {
		const { orientation, disabled, thumbAlignment } = this.#props;
		const { pointerPercent, dragging, pointing, focused } = this.#input;
		return {
			value,
			fillPercent: this.percentFromValue(value),
			pointerPercent,
			dragging,
			pointing,
			interactive: dragging || pointing || focused,
			orientation,
			disabled,
			thumbAlignment
		};
	}
	getLabel(state) {
		return resolveLabel(this.#props.label, state) || "";
	}
	getAttrs(state) {
		return {
			role: "slider",
			tabIndex: state.disabled ? -1 : 0,
			autoComplete: "off",
			"aria-label": this.getLabel(state),
			"aria-valuemin": this.#props.min,
			"aria-valuemax": this.#props.max,
			"aria-valuenow": state.value,
			"aria-orientation": state.orientation,
			"aria-disabled": state.disabled ? "true" : void 0
		};
	}
	valueFromPercent(percent) {
		const { min, max, step } = this.#props;
		return roundToStep(clamp(min + percent / 100 * (max - min), min, max), step, min);
	}
	/** Convert percent to a clamped value without applying step rounding. */
	rawValueFromPercent(percent) {
		const { min, max } = this.#props;
		return clamp(min + percent / 100 * (max - min), min, max);
	}
	percentFromValue(value) {
		const { min, max } = this.#props;
		return toPercent(value, min, max);
	}
	/** Step as a percentage of the slider range. */
	getStepPercent() {
		const { step, min, max } = this.#props;
		const range = max - min;
		return range > 0 ? step / range * 100 : 0;
	}
	/** Large step as a percentage of the slider range. */
	getLargeStepPercent() {
		const { largeStep, min, max } = this.#props;
		const range = max - min;
		return range > 0 ? largeStep / range * 100 : 0;
	}
	adjustPercentForAlignment(rawPercent, thumbSize, trackSize) {
		if (this.#props.thumbAlignment === "center" || trackSize === 0) return rawPercent;
		const thumbHalf = thumbSize / trackSize * 100 / 2;
		const minPercent = thumbHalf;
		const maxPercent = 100 - thumbHalf;
		return minPercent + rawPercent / 100 * (maxPercent - minPercent);
	}
};

//#endregion
//#region ../core/dist/default/core/ui/slider/slider-data-attrs.js
const SliderDataAttrs = {
	/** Present when the user is actively dragging. */
	dragging: "data-dragging",
	/** Present when the pointer is over the slider. */
	pointing: "data-pointing",
	/** Present when dragging or pointing is active. */
	interactive: "data-interactive",
	/** Current axis of slider movement (`horizontal` or `vertical`). */
	orientation: "data-orientation",
	/** Present when the slider is non-interactive. */
	disabled: "data-disabled"
};

//#endregion
//#region ../core/dist/default/core/ui/slider/slider-segments-core.js
/** Localizes ordered numeric ranges into slider geometry and interaction state. */
var SliderSegmentsCore = class {
	getGeometry(input) {
		const { ranges, min, max, orientation } = input;
		const domain = max - min;
		if (!Number.isFinite(domain) || domain <= 0) return [];
		const valid = ranges.filter((segment) => {
			const size = (segment.end - segment.start) / domain;
			const offset = (segment.start - min) / domain;
			return Number.isFinite(size) && Number.isFinite(offset) && size > 0;
		});
		return valid.map((segment, index) => {
			const offset = (segment.start - min) / domain;
			const size = (segment.end - segment.start) / domain;
			const segmentSize = `${size * 100}%`;
			return {
				...segment,
				index,
				last: index === valid.length - 1,
				orientation,
				width: orientation === "horizontal" ? segmentSize : void 0,
				height: orientation === "vertical" ? segmentSize : void 0,
				startPercent: `${offset * 100}%`,
				endPercent: `${(offset + size) * 100}%`
			};
		});
	}
	getState(segment, slider, pointerValue) {
		const { last, ...geometry } = segment;
		const contains = (value) => value >= segment.start && (value < segment.end || last && value === segment.end);
		const active = contains(slider.value);
		const pointing = slider.pointing && contains(pointerValue);
		const dragging = slider.dragging && contains(pointerValue);
		const focused = slider.interactive && !slider.pointing && !slider.dragging;
		return {
			...geometry,
			fillPercent: toPercent(slider.value, segment.start, segment.end),
			active,
			pointing,
			dragging,
			highlighted: segment.highlight !== false && pointing,
			interactive: pointing || dragging || focused && active
		};
	}
};

//#endregion
//#region ../core/dist/default/core/ui/status-announcer/status-announcer-labels.js
const DEFAULT_STATUS_ANNOUNCER_LABELS = {
	...DEFAULT_INPUT_INDICATOR_LABELS,
	volumeWithValue: (value) => translateText(valueText, { value }),
	seekedTo: (time) => translateText(seekedToText, { time: formatTimeAsPhrase(time) }),
	playbackRate: (rate) => translateText(rateText, { rate })
};
/** Adds the parameterized labels used by status announcements. */
function createStatusAnnouncerLabels(translator, locale = "en") {
	return {
		...createInputIndicatorLabels(translator),
		volumeWithValue: (value) => translator(valueText, { value }),
		seekedTo: (time) => translator(seekedToText, { time: formatTimeAsPhrase(time, { locale }) }),
		playbackRate: (rate) => translator(rateText, { rate })
	};
}

//#endregion
//#region ../core/dist/default/core/ui/volume-indicator/volume-indicator-status.js
function isVolumeIndicatorAction(action) {
	return action === "toggleMuted" || action === "volumeStep";
}
function getVolumeLevel(volume) {
	if (volume <= 0) return "off";
	return volume <= .5 ? "low" : "high";
}
function formatVolumeValue(volume) {
	return `${Math.round(clamp(volume, 0, 1) * 100)}%`;
}
function getVolumeIndicatorDisplayValue(state) {
	return state.value ?? "";
}
/** Predicted mute/volume after a volume-indicator action. */
function predictVolumeActionOutcome(event, snapshot) {
	const muted = snapshot.muted === true;
	const snapshotVolume = snapshot.volume ?? 0;
	if (event.action === "toggleMuted") return {
		snapshotVolume,
		nextMuted: !muted,
		nextVolume: snapshotVolume
	};
	if (event.action === "volumeStep") {
		const nextVolume = clamp(snapshotVolume + (event.value ?? 0), 0, 1);
		return {
			snapshotVolume,
			nextMuted: muted && nextVolume <= 0,
			nextVolume
		};
	}
	return {
		snapshotVolume,
		nextMuted: muted,
		nextVolume: snapshotVolume
	};
}
/** Labels/value/level for volume actions, shared with `StatusIndicatorCore`. */
function deriveVolumeStatus(event, snapshot, labels = DEFAULT_INPUT_INDICATOR_LABELS, cachedPrediction) {
	const prediction = cachedPrediction ?? predictVolumeActionOutcome(event, snapshot);
	const level = prediction.nextMuted ? "off" : getVolumeLevel(prediction.nextVolume);
	const value = prediction.nextMuted ? "0%" : formatVolumeValue(prediction.nextVolume);
	return {
		status: level === "off" ? "volume-off" : level === "low" ? "volume-low" : "volume-high",
		label: level === "off" ? labels.muted : labels.volume,
		value,
		volumeLevel: level
	};
}

//#endregion
//#region ../core/dist/default/core/ui/status-announcer/status-announcer-status.js
function deriveStatusAnnouncement(previous, snapshot, labels = DEFAULT_STATUS_ANNOUNCER_LABELS) {
	const announcements = [];
	if (hasChanged(previous.paused, snapshot.paused)) announcements.push(snapshot.paused ? labels.paused : labels.playing);
	if (hasChanged(previous.subtitlesShowing, snapshot.subtitlesShowing) && snapshot.subtitlesAvailable !== false) announcements.push(snapshot.subtitlesShowing ? labels.captionsOn : labels.captionsOff);
	if (hasChanged(previous.fullscreen, snapshot.fullscreen)) announcements.push(snapshot.fullscreen ? labels.fullscreen : labels.exitFullscreen);
	if (hasChanged(previous.pip, snapshot.pip)) announcements.push(snapshot.pip ? labels.pictureInPicture : labels.exitPictureInPicture);
	if (hasChanged(previous.playbackRate, snapshot.playbackRate)) announcements.push(labels.playbackRate(`${snapshot.playbackRate}×`));
	return announcements.length > 0 ? announcements.join(". ") : null;
}
function deriveVolumeAnnouncement(previous, snapshot, labels = DEFAULT_STATUS_ANNOUNCER_LABELS) {
	if (!hasChanged(previous.volume, snapshot.volume) && !hasChanged(previous.muted, snapshot.muted)) return null;
	const volume = snapshot.volume ?? previous.volume;
	const muted = snapshot.muted ?? previous.muted;
	if (volume === void 0 && muted === void 0) return null;
	return muted || (volume ?? 0) <= 0 ? labels.muted : labels.volumeWithValue(formatVolumeValue(volume ?? 0));
}
function hasChanged(previous, next) {
	return previous !== void 0 && next !== void 0 && !Object.is(previous, next);
}

//#endregion
//#region ../core/dist/default/core/ui/status-announcer/status-announcer-core.js
const ANNOUNCEMENT_DEBOUNCE = 200;
var StatusAnnouncerCore = class {
	state = createState({
		generation: 0,
		label: null
	});
	#props = {};
	#snapshot = null;
	#seekStartTime = null;
	#seekTargetTime = null;
	#timer = null;
	#close = new IndicatorCloseController(() => this.state.patch({ label: null }), () => getIndicatorCloseDelay(this.#props));
	setProps(props) {
		this.#props = props;
	}
	resetSnapshot() {
		this.#snapshot = null;
		this.#seekStartTime = null;
		this.#seekTargetTime = null;
		this.#clearTimer();
		this.#close.close();
	}
	destroy() {
		this.#clearTimer();
		this.#close.destroy();
	}
	processSnapshot(snapshot) {
		const previous = this.#snapshot;
		this.#snapshot = snapshot;
		if (!previous) return false;
		const labels = this.#getLabels();
		const statusLabel = deriveStatusAnnouncement(previous, snapshot, labels);
		const statusHandled = statusLabel !== null && this.#announce(statusLabel);
		const seekHandled = this.#processSeekSnapshot(previous, snapshot, labels, statusHandled);
		const volumeHandled = this.#processVolumeSnapshot(previous, snapshot, labels, statusHandled || seekHandled);
		return statusHandled || seekHandled || volumeHandled;
	}
	#getLabels() {
		return {
			...DEFAULT_STATUS_ANNOUNCER_LABELS,
			...this.#props.labels
		};
	}
	#announce(label) {
		this.#clearTimer();
		this.state.patch({
			generation: this.state.current.generation + 1,
			label
		});
		this.#close.arm();
		return true;
	}
	#processVolumeSnapshot(previous, snapshot, labels, alreadyHandled) {
		const label = deriveVolumeAnnouncement(previous, snapshot, labels);
		if (label === null || alreadyHandled || !this.#shouldAnnounce()) return false;
		this.#schedule(label);
		return true;
	}
	#processSeekSnapshot(previous, snapshot, labels, alreadyHandled) {
		if (previous.seeking !== true && snapshot.seeking === true) {
			this.#seekStartTime = previous.currentTime ?? null;
			this.#seekTargetTime = snapshot.currentTime ?? null;
			this.#clearTimer();
			return false;
		}
		if (snapshot.seeking === true) {
			this.#seekTargetTime = snapshot.currentTime ?? this.#seekTargetTime;
			return false;
		}
		if (previous.seeking !== true || snapshot.seeking !== false) return false;
		const targetTime = snapshot.currentTime ?? this.#seekTargetTime;
		const startTime = this.#seekStartTime;
		this.#seekStartTime = null;
		this.#seekTargetTime = null;
		if (targetTime === void 0 || targetTime === null || Object.is(targetTime, startTime)) return false;
		if (alreadyHandled || !this.#shouldAnnounce()) return false;
		this.#schedule(labels.seekedTo(targetTime));
		return true;
	}
	#schedule(label) {
		this.#clearTimer();
		this.#timer = setTimeout(() => {
			this.#timer = null;
			if (!this.#shouldAnnounce()) return;
			this.#announce(label);
		}, ANNOUNCEMENT_DEBOUNCE);
	}
	#shouldAnnounce() {
		return this.#props.shouldAnnounce?.() !== false;
	}
	#clearTimer() {
		if (this.#timer === null) return;
		clearTimeout(this.#timer);
		this.#timer = null;
	}
};

//#endregion
//#region ../core/dist/default/core/ui/status-indicator/status-indicator-status.js
function deriveStatus(event, snapshot, labels = DEFAULT_INPUT_INDICATOR_LABELS) {
	switch (event.action) {
		case "togglePaused": {
			const paused = snapshot.paused !== void 0 ? !snapshot.paused : true;
			return {
				status: paused ? "pause" : "play",
				label: paused ? labels.paused : labels.playing,
				value: null
			};
		}
		case "toggleMuted":
		case "volumeStep": return deriveVolumeStatus(event, snapshot, labels);
		case "toggleSubtitles": {
			if (snapshot.subtitlesAvailable === false) return null;
			const showing = snapshot.subtitlesShowing !== void 0 ? !snapshot.subtitlesShowing : true;
			return {
				status: showing ? "captions-on" : "captions-off",
				label: showing ? labels.captionsOn : labels.captionsOff,
				value: null
			};
		}
		case "toggleFullscreen": {
			const fullscreen = snapshot.fullscreen !== void 0 ? !snapshot.fullscreen : true;
			return {
				status: fullscreen ? "fullscreen" : "exit-fullscreen",
				label: fullscreen ? labels.fullscreen : labels.exitFullscreen,
				value: null
			};
		}
		case "togglePictureInPicture": {
			const pip = snapshot.pip !== void 0 ? !snapshot.pip : true;
			return {
				status: pip ? "pip" : "exit-pip",
				label: pip ? labels.pictureInPicture : labels.exitPictureInPicture,
				value: null
			};
		}
		default: return null;
	}
}
function getStatusIndicatorDisplayValue(state) {
	return state.value ?? state.label ?? "";
}

//#endregion
//#region ../core/dist/default/core/ui/status-indicator/status-indicator-core.js
const INITIAL_STATE$1 = {
	open: false,
	generation: 0,
	status: null,
	label: null,
	value: null,
	transitionStarting: false,
	transitionEnding: false
};
var StatusIndicatorCore = class {
	state = createState({ ...INITIAL_STATE$1 });
	#props = {};
	#close = new IndicatorCloseController(() => this.state.patch({
		open: false,
		status: null,
		label: null,
		value: null
	}), () => getIndicatorCloseDelay(this.#props));
	setProps(props) {
		this.#props = props;
	}
	destroy() {
		this.#close.destroy();
	}
	close() {
		this.#close.close();
	}
	processEvent(event, snapshot) {
		if (!isInputActionIncluded(event.action, this.#props.actions)) return false;
		const details = deriveStatus(event, snapshot, {
			...DEFAULT_INPUT_INDICATOR_LABELS,
			...this.#props.labels
		});
		if (!details) return false;
		this.state.patch({
			open: true,
			generation: this.state.current.generation + 1,
			status: details.status,
			label: details.label,
			value: details.value
		});
		this.#close.arm();
		return true;
	}
};

//#endregion
//#region ../core/dist/default/core/ui/status-indicator/status-indicator-data-attrs.js
const StatusIndicatorDataAttrs = {
	open: "data-open",
	status: "data-status",
	transitionStarting: "data-starting-style",
	transitionEnding: "data-ending-style"
};

//#endregion
//#region ../core/dist/default/core/ui/thumbnail/thumbnail-data-attrs.js
const ThumbnailDataAttrs = {
	loading: "data-loading",
	error: "data-error",
	hidden: "data-hidden"
};

//#endregion
//#region ../core/dist/default/core/ui/thumbnail/thumbnail-media-fragment.js
/** Parse `url#xywh=x,y,w,h` into a URL and optional sprite coordinates. */
function parseMediaFragment(text, baseURL) {
	const parts = text.trim().split("#");
	const rawURL = parts[0] ?? "";
	const hash = parts[1];
	const url = baseURL ? new URL(rawURL, baseURL).href : rawURL;
	if (!hash) return { url };
	const eqIndex = hash.indexOf("=");
	if (eqIndex === -1) return { url };
	const keys = hash.slice(0, eqIndex);
	const values = hash.slice(eqIndex + 1).split(",").map(Number);
	const data = {};
	for (let i = 0; i < keys.length; i++) {
		const key = keys[i];
		const value = values[i];
		if (key && isNumber(value) && !Number.isNaN(value)) data[key] = value;
	}
	const result = { url };
	if (isNumber(data.w)) result.width = data.w;
	if (isNumber(data.h)) result.height = data.h;
	if (isNumber(data.x) && isNumber(data.y)) result.coords = {
		x: data.x,
		y: data.y
	};
	return result;
}
/**
* Convert an array of text cues (e.g. `VTTCue` from a `<track>` element)
* into {@link ThumbnailImage} entries by parsing the media-fragment in
* each cue's text.
*/
function mapCuesToThumbnails(cues, baseURL) {
	const images = [];
	for (const cue of cues) {
		const fragment = parseMediaFragment(cue.text, baseURL);
		const image = {
			url: fragment.url,
			startTime: cue.startTime,
			endTime: cue.endTime
		};
		if (fragment.width) image.width = fragment.width;
		if (fragment.height) image.height = fragment.height;
		if (fragment.coords) image.coords = fragment.coords;
		images.push(image);
	}
	return images;
}

//#endregion
//#region ../core/dist/default/i18n/text/time.js
const prefix = "time.";
const currentText = {
	key: `${prefix}current`,
	text: "Current time"
};
const durationText = {
	key: `${prefix}duration`,
	text: "Duration"
};
const remainingText = {
	key: `${prefix}remaining`,
	text: "Remaining"
};
const elapsedSuffixText = {
	key: `${prefix}elapsedSuffix`,
	text: "{duration} elapsed"
};
const durationSuffixText = {
	key: `${prefix}durationSuffix`,
	text: "{duration} duration"
};
const remainingSuffixText = {
	key: `${prefix}remainingSuffix`,
	text: "{duration} remaining"
};
const showElapsedText = {
	key: `${prefix}showElapsed`,
	text: "Show elapsed time, {duration}."
};
const showDurationText = {
	key: `${prefix}showDuration`,
	text: "Show duration, {duration}."
};
const showRemainingText = {
	key: `${prefix}showRemaining`,
	text: "Show remaining time, {duration}."
};
const toggleElapsedText = {
	key: `${prefix}toggleElapsed`,
	text: "Toggle between elapsed and remaining time."
};
const toggleDurationText = {
	key: `${prefix}toggleDuration`,
	text: "Toggle between duration and remaining time."
};
const positionText = {
	key: `${prefix}position`,
	text: "{current} of {duration}"
};

//#endregion
//#region ../core/dist/default/core/ui/time/time-core.js
const TOGGLE_LABELS = {
	current: showElapsedText,
	duration: showDurationText,
	remaining: showRemainingText
};
const DEFAULT_LABELS$1 = {
	current: currentText,
	duration: durationText,
	remaining: remainingText
};
const TOGGLE_DESCRIPTIONS = {
	current: toggleElapsedText,
	duration: toggleDurationText,
	remaining: toggleDurationText
};
var TimeCore = class TimeCore {
	static defaultProps = {
		type: "current",
		negativeSign: "-",
		label: "",
		toggle: false
	};
	#props = { ...TimeCore.defaultProps };
	#media = null;
	#formatLocale;
	constructor(props) {
		if (props) this.setProps(props);
	}
	setProps(props) {
		this.#props = defaults(props, TimeCore.defaultProps);
	}
	setMedia(media) {
		this.#media = media;
	}
	/** @internal Platform adapters set the active i18n locale for digital time formatting. */
	setFormatLocale(locale) {
		this.#formatLocale = locale;
	}
	#getSeconds() {
		const media = this.#media;
		const { type } = this.#props;
		switch (type) {
			case "current": return media.currentTime;
			case "duration": return media.duration;
			case "remaining": return media.currentTime - media.duration;
			default: return 0;
		}
	}
	#getText() {
		const media = this.#media;
		const seconds = this.#getSeconds();
		const options = this.#formatLocale === void 0 ? void 0 : { locale: this.#formatLocale };
		return formatTime$1(Math.abs(seconds), media.duration, options);
	}
	#getPhrase() {
		const { type } = this.#props;
		const seconds = this.#getSeconds();
		if (type === "remaining") return formatTimeAsPhrase(seconds < 0 ? seconds : -Math.abs(seconds));
		return formatTimeAsPhrase(seconds);
	}
	#getDatetime() {
		const seconds = this.#getSeconds();
		return secondsToIsoDuration(Math.abs(seconds));
	}
	#getToggleType(type, currentType) {
		if (type === "current") return currentType === "remaining" ? "current" : "remaining";
		return currentType === "duration" ? "remaining" : "duration";
	}
	getLabel(state, type = this.#props.type) {
		const custom = resolveLabel(this.#props.label, state);
		if (custom !== void 0) return custom;
		if (!this.#props.toggle) return DEFAULT_LABELS$1[this.#props.type];
		return TOGGLE_LABELS[this.#getToggleType(type, state.type)];
	}
	getLabelParams(state) {
		if (resolveLabel(this.#props.label, state) !== void 0 || !this.#props.toggle) return void 0;
		const options = this.#formatLocale === void 0 ? void 0 : { locale: this.#formatLocale };
		const duration = formatTimeAsPhrase(Math.abs(state.seconds), options);
		switch (state.type) {
			case "current": return { duration: `${duration} elapsed` };
			case "duration": return { duration: `${duration} duration` };
			case "remaining": return { duration: `${duration} remaining` };
		}
	}
	getDescription(type = this.#props.type) {
		return this.#props.toggle ? TOGGLE_DESCRIPTIONS[type] : void 0;
	}
	getAttrs(state, type = this.#props.type) {
		return {
			"aria-label": this.getLabel(state, type),
			"aria-description": this.getDescription(type),
			role: this.#props.toggle ? "button" : void 0,
			tabIndex: this.#props.toggle ? 0 : void 0
		};
	}
	getState() {
		const seconds = this.#getSeconds();
		return {
			type: this.#props.type,
			seconds,
			negative: this.#props.type === "remaining" && seconds < 0,
			text: this.#getText(),
			phrase: this.#getPhrase(),
			datetime: this.#getDatetime()
		};
	}
};

//#endregion
//#region ../core/dist/default/core/ui/time/time-data-attrs.js
const TimeDataAttrs = { 
/** The type of time being displayed. */
type: "data-type" };

//#endregion
//#region ../core/dist/default/core/ui/time-slider/time-slider-chapters/core.js
const cueKeys = /* @__PURE__ */ new WeakMap();
let cueKey = 0;
function getCueKey(cue) {
	let key = cueKeys.get(cue);
	if (!key) {
		const id = cue.id;
		key = `cue-${typeof id === "string" && id ? `${id}-` : ""}${cueKey++}`;
		cueKeys.set(cue, key);
	}
	return key;
}
/** Produces an ordered, non-overlapping, contiguous partition of the slider domain. */
function normalizeChapterCues(cues, min, max) {
	if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [];
	const sorted = cues.map((cue, index) => ({
		cue,
		index,
		key: getCueKey(cue)
	})).filter(({ cue }) => Number.isFinite(cue.startTime) && Number.isFinite(cue.endTime)).sort((a, b) => a.cue.startTime - b.cue.startTime || a.index - b.index);
	const chapters = [];
	let end = min;
	let previousKey = "start";
	for (const { cue, key } of sorted) {
		const start = Math.max(min, cue.startTime);
		const cueEnd = Math.min(max, cue.endTime);
		if (cueEnd <= start) continue;
		if (start > end) chapters.push({
			key: `gap-${previousKey}-${key}`,
			start: end,
			end: start,
			cue: null
		});
		const segmentStart = Math.max(start, end);
		if (cueEnd <= segmentStart) continue;
		chapters.push({
			key,
			start: segmentStart,
			end: cueEnd,
			cue
		});
		end = cueEnd;
		previousKey = key;
	}
	if (chapters.length === 0) return [{
		key: "gap-start-end",
		start: min,
		end: max,
		cue: null
	}];
	if (end < max) chapters.push({
		key: `gap-${previousKey}-end`,
		start: end,
		end: max,
		cue: null
	});
	return chapters;
}
/** Prepares chapter ranges and state for platform renderers. */
var TimeSliderChaptersCore = class {
	#cues = null;
	#min = 0;
	#max = 0;
	#result = null;
	getRanges(cues, min, max) {
		if (this.#result && (this.#cues === cues || this.#cues?.length === 0 && cues.length === 0) && this.#min === min && this.#max === max) return this.#result;
		const chapters = normalizeChapterCues(cues, min, max);
		const hasChapters = chapters.some((chapter) => chapter.cue !== null);
		const rangeMax = max > min ? max : min + 1;
		const ranges = hasChapters ? chapters.map(({ key, start, end, cue }) => ({
			key,
			start,
			end,
			highlight: cue !== null
		})) : [{
			key: "fallback",
			start: min,
			end: rangeMax,
			highlight: false
		}];
		this.#cues = cues;
		this.#min = min;
		this.#max = max;
		this.#result = {
			chapters,
			ranges,
			max: rangeMax,
			hasChapters
		};
		return this.#result;
	}
	findChapter(chapters, value) {
		return findRangeAt(chapters, value, (chapter) => chapter.start, (chapter) => chapter.end);
	}
	getState(segment, chapters, bufferedEnd) {
		return {
			...segment,
			cue: chapters[segment.index]?.cue ?? null,
			bufferPercent: toPercent(bufferedEnd, segment.start, segment.end)
		};
	}
};

//#endregion
//#region ../core/dist/default/core/ui/time-slider/time-slider-chapters/css-vars.js
/** CSS geometry and progress local to each chapter. */
const TimeSliderChapterCSSVars = {
	start: "--media-slider-chapter-start",
	end: "--media-slider-chapter-end",
	width: "--media-slider-chapter-width",
	fill: "--media-slider-chapter-fill",
	buffer: "--media-slider-chapter-buffer"
};

//#endregion
//#region ../core/dist/default/core/ui/time-slider/time-slider-chapters/data-attrs.js
const TimeSliderChapterDataAttrs = {
	/** Present when playback is within the chapter. */
	active: "data-active",
	/** Present when pointer interaction highlights the chapter. */
	highlighted: "data-highlighted"
};

//#endregion
//#region ../core/dist/default/i18n/text/slider.js
const seekText = {
	key: `slider.seek`,
	text: "Seek"
};

//#endregion
//#region ../core/dist/default/core/ui/time-slider/time-slider-core.js
/** Time-domain slider: maps media time/buffer state to slider state. */
var TimeSliderCore = class TimeSliderCore extends SliderCore {
	static defaultProps = {
		...SliderCore.defaultProps,
		label: "",
		changeThrottle: 100,
		pauseOnDrag: false
	};
	#props = { ...TimeSliderCore.defaultProps };
	#media = null;
	#formatLocale;
	#wasPlayingBeforeDrag = false;
	constructor(props) {
		super();
		if (props) this.setProps(props);
	}
	setProps(props) {
		this.#props = defaults(props, TimeSliderCore.defaultProps);
		super.setProps({
			...props,
			min: 0
		});
	}
	setMedia(media) {
		this.#media = media;
	}
	/** @internal Platform adapters set the active i18n locale for `aria-valuetext` time formatting. */
	setFormatLocale(locale) {
		this.#formatLocale = locale;
	}
	getState() {
		const { duration, currentTime, seeking, buffered } = this.#media;
		super.setProps({
			...this.#props,
			min: 0,
			max: duration
		});
		const base = super.getSliderState(currentTime);
		const bufferPercent = toPercent(buffered.length > 0 ? buffered[buffered.length - 1][1] : 0, 0, duration);
		return {
			...base,
			currentTime,
			duration,
			seeking,
			bufferPercent
		};
	}
	getLabel(state) {
		return super.getLabel(state) || seekText;
	}
	#announceValue(state) {
		return state.dragging ? this.rawValueFromPercent(state.pointerPercent) : state.value;
	}
	#formatTimeAsPhrase(seconds) {
		return this.#formatLocale === void 0 ? formatTimeAsPhrase(seconds) : formatTimeAsPhrase(seconds, { locale: this.#formatLocale });
	}
	getValueText(state) {
		return Number.isFinite(state.duration) ? positionText : this.getValueTextParams(state).current;
	}
	getValueTextParams(state) {
		const current = this.#formatTimeAsPhrase(this.#announceValue(state));
		if (!Number.isFinite(state.duration)) return { current };
		return {
			current,
			duration: this.#formatTimeAsPhrase(state.duration)
		};
	}
	/**
	* Pause playback when a drag begins if `pauseOnDrag` is enabled, remembering
	* whether media was playing so `endDrag` can resume it.
	*/
	startDrag(playback) {
		this.#wasPlayingBeforeDrag = false;
		if (this.#props.pauseOnDrag && playback && !playback.paused) {
			this.#wasPlayingBeforeDrag = true;
			playback.pause();
		}
	}
	/**
	* Resume playback if `startDrag` paused it. Resume depends only on the intent
	* captured at drag start, so it survives `pauseOnDrag` being toggled mid-drag.
	* Safe to call on teardown — a no-op unless a drag paused playback.
	*/
	endDrag(playback) {
		if (this.#wasPlayingBeforeDrag) playback?.play().catch(() => {});
		this.#wasPlayingBeforeDrag = false;
	}
	getAttrs(state) {
		const base = super.getAttrs(state);
		const announceValue = this.#announceValue(state);
		return {
			...base,
			"aria-valuenow": announceValue,
			"aria-valuetext": this.getValueText(state)
		};
	}
};

//#endregion
//#region ../core/dist/default/core/ui/time-slider/time-slider-data-attrs.js
const TimeSliderDataAttrs = {
	...SliderDataAttrs,
	/** Present when a seek operation is in progress. */
	seeking: "data-seeking"
};

//#endregion
//#region ../core/dist/default/core/ui/tooltip/tooltip-core.js
var TooltipCore = class TooltipCore {
	static defaultProps = {
		side: "top",
		align: "center",
		open: false,
		defaultOpen: false,
		delay: 600,
		closeDelay: 0,
		disableHoverablePopup: true,
		disabled: false
	};
	#props = { ...TooltipCore.defaultProps };
	constructor(props) {
		if (props) this.setProps(props);
	}
	setProps(props) {
		this.#props = defaults(props, TooltipCore.defaultProps);
	}
	#input = null;
	setInput(input) {
		this.#input = input;
	}
	getState() {
		const input = this.#input;
		return {
			open: input.active,
			status: input.status,
			side: this.#props.side,
			align: this.#props.align,
			...getTransitionFlags(input.status)
		};
	}
	getPopupAttrs(_state) {
		return {
			popover: "manual",
			role: "presentation"
		};
	}
};

//#endregion
//#region ../core/dist/default/core/ui/tooltip/tooltip-css-vars.js
const TooltipCSSVars = {
	/** Distance between the popup and the trigger along the side axis. */
	sideOffset: "--media-tooltip-side-offset",
	/** Distance between the popup and the trigger along the alignment axis. */
	alignOffset: "--media-tooltip-align-offset",
	/** Minimum distance between the popup and the positioning boundary. */
	boundaryOffset: "--media-tooltip-boundary-offset",
	/** The anchor element's width. */
	anchorWidth: "--media-tooltip-anchor-width",
	/** The anchor element's height. */
	anchorHeight: "--media-tooltip-anchor-height",
	/** Available width between the trigger and the boundary edge. */
	availableWidth: "--media-tooltip-available-width",
	/** Available height between the trigger and the boundary edge. */
	availableHeight: "--media-tooltip-available-height"
};

//#endregion
//#region ../core/dist/default/core/ui/tooltip/tooltip-data-attrs.js
const TooltipDataAttrs = {
	/** Present when the tooltip is open. */
	open: "data-open",
	/** Indicates the rendered side of the tooltip after collision handling. */
	side: "data-side",
	/** Indicates how the tooltip is aligned relative to the specified side. */
	align: "data-align",
	...TransitionDataAttrs
};

//#endregion
//#region ../core/dist/default/core/ui/tooltip/tooltip-group-core.js
var TooltipGroupCore = class TooltipGroupCore {
	static defaultProps = {
		delay: 600,
		closeDelay: 0,
		timeout: 400
	};
	#props = { ...TooltipGroupCore.defaultProps };
	#lastCloseTime = 0;
	#isOpen = false;
	constructor(props) {
		if (props) this.setProps(props);
	}
	setProps(props) {
		this.#props = defaults(props, TooltipGroupCore.defaultProps);
	}
	get delay() {
		return this.#props.delay;
	}
	get closeDelay() {
		return this.#props.closeDelay;
	}
	shouldSkipDelay() {
		if (this.#isOpen) return true;
		return Date.now() - this.#lastCloseTime < this.#props.timeout;
	}
	notifyOpen() {
		this.#isOpen = true;
	}
	notifyClose() {
		this.#isOpen = false;
		this.#lastCloseTime = Date.now();
	}
};

//#endregion
//#region ../core/dist/default/core/ui/volume-indicator/volume-indicator-core.js
const BOUNDARY_CLEAR_DELAY = 300;
const INITIAL_STATE = {
	open: false,
	generation: 0,
	level: null,
	value: null,
	fill: null,
	min: false,
	max: false,
	transitionStarting: false,
	transitionEnding: false
};
var VolumeIndicatorCore = class {
	state = createState({ ...INITIAL_STATE });
	#props = {};
	#boundaryTimer = null;
	#boundaryRestartTimer = null;
	#close = new IndicatorCloseController(() => this.state.patch({
		open: false,
		level: null,
		value: null,
		fill: null,
		min: false,
		max: false
	}), () => getIndicatorCloseDelay(this.#props));
	setProps(props) {
		this.#props = props;
	}
	destroy() {
		this.#close.destroy();
		this.#clearBoundaryTimers();
	}
	close() {
		this.#clearBoundaryTimers();
		this.#close.close();
	}
	processEvent(event, snapshot) {
		if (!isVolumeIndicatorAction(event.action)) return false;
		const current = this.state.current;
		const prediction = predictVolumeActionOutcome(event, snapshot);
		const details = deriveVolumeStatus(event, snapshot, {
			...DEFAULT_INPUT_INDICATOR_LABELS,
			...this.#props.labels
		}, prediction);
		const boundary = getVolumeBoundary(event, prediction.snapshotVolume, prediction.nextVolume);
		const repeatedBoundary = boundary !== null && current[boundary] === true;
		if (!boundary) this.#clearBoundaryTimers();
		this.state.patch({
			open: true,
			generation: current.generation + 1,
			level: details.volumeLevel,
			value: details.value,
			fill: details.value,
			min: boundary === "min" && !repeatedBoundary,
			max: boundary === "max" && !repeatedBoundary
		});
		if (boundary) if (repeatedBoundary) this.#restartBoundary(boundary);
		else this.#scheduleBoundaryClear();
		this.#close.arm();
		return true;
	}
	#scheduleBoundaryClear() {
		this.#clearBoundaryTimer();
		this.#boundaryTimer = setTimeout(() => {
			this.#boundaryTimer = null;
			this.state.patch({
				min: false,
				max: false
			});
		}, BOUNDARY_CLEAR_DELAY);
	}
	#restartBoundary(boundary) {
		this.#clearBoundaryTimers();
		this.state.patch({
			min: false,
			max: false
		});
		this.#boundaryRestartTimer = setTimeout(() => {
			this.#boundaryRestartTimer = null;
			this.state.patch({ [boundary]: true });
			this.#scheduleBoundaryClear();
		}, 0);
	}
	#clearBoundaryTimer() {
		if (this.#boundaryTimer === null) return;
		clearTimeout(this.#boundaryTimer);
		this.#boundaryTimer = null;
	}
	#clearBoundaryRestartTimer() {
		if (this.#boundaryRestartTimer === null) return;
		clearTimeout(this.#boundaryRestartTimer);
		this.#boundaryRestartTimer = null;
	}
	#clearBoundaryTimers() {
		this.#clearBoundaryTimer();
		this.#clearBoundaryRestartTimer();
	}
};
function getVolumeBoundary(event, currentVolume, nextVolume) {
	if (event.action !== "volumeStep" || event.value === void 0 || event.value === 0) return null;
	if (nextVolume !== currentVolume) return null;
	return event.value < 0 ? "min" : "max";
}

//#endregion
//#region ../core/dist/default/core/ui/volume-indicator/volume-indicator-css-vars.js
const VolumeIndicatorCSSVars = { fill: "--media-volume-fill" };

//#endregion
//#region ../core/dist/default/core/ui/volume-indicator/volume-indicator-data-attrs.js
const VolumeIndicatorDataAttrs = {
	open: "data-open",
	level: "data-level",
	min: "data-min",
	max: "data-max",
	transitionStarting: "data-starting-style",
	transitionEnding: "data-ending-style"
};

//#endregion
//#region ../utils/dist/percent/percent.js
const formatters = /* @__PURE__ */ new Map();
function localeCacheKey(locale) {
	if (locale === void 0) return "";
	return Array.isArray(locale) ? locale.join(":") : locale;
}
function getFormatter(locale) {
	const key = localeCacheKey(locale);
	let formatter = formatters.get(key);
	if (!formatter) try {
		formatter = new Intl.NumberFormat(locale, {
			style: "percent",
			maximumFractionDigits: 0
		});
		formatters.set(key, formatter);
	} catch {
		return;
	}
	return formatter;
}
function formatFallback(fraction) {
	return `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
}
/** Format a fraction (0-1) with {@link Intl.NumberFormat} `style: "percent"`. */
function formatPercent(fraction, locale) {
	const value = !isNumber(fraction) || !Number.isFinite(fraction) ? 0 : Math.min(1, Math.max(0, fraction));
	try {
		const formatter = getFormatter(locale) ?? getFormatter(void 0);
		if (formatter) return formatter.format(value);
	} catch {}
	return formatFallback(value);
}

//#endregion
//#region ../core/dist/default/core/ui/volume-slider/volume-slider-core.js
/** Volume-domain slider: maps media volume/mute state to slider state. */
var VolumeSliderCore = class VolumeSliderCore extends SliderCore {
	static defaultProps = {
		...SliderCore.defaultProps,
		label: "",
		wheelStep: 5
	};
	#media = null;
	#formatLocale;
	constructor(props) {
		super();
		if (props) this.setProps(props);
	}
	setProps(props) {
		super.setProps(defaults(props, VolumeSliderCore.defaultProps));
	}
	setMedia(media) {
		this.#media = media;
	}
	/** @internal Platform adapters set the active i18n locale for `aria-valuetext` percent formatting. */
	setFormatLocale(locale) {
		this.#formatLocale = locale;
	}
	getState() {
		const media = this.#media;
		const { volume, muted } = media;
		const effectivelyMuted = muted || volume === 0;
		const { dragging, dragPercent } = this.input;
		const volumePercent = volume * 100;
		const value = dragging ? this.valueFromPercent(dragPercent) : volumePercent;
		const base = super.getSliderState(value);
		const availability = media.volumeAvailability;
		return {
			...base,
			disabled: base.disabled || availability !== "available",
			fillPercent: effectivelyMuted ? 0 : base.fillPercent,
			volume,
			muted: effectivelyMuted,
			availability,
			hidden: availability !== "available"
		};
	}
	/** Wheel step as a percentage of the slider range. */
	getWheelStepPercent() {
		const props = this.props;
		const range = props.max - props.min;
		return range > 0 ? props.wheelStep / range * 100 : 0;
	}
	getLabel(state) {
		return super.getLabel(state) || labelText;
	}
	getValueText(state) {
		return state.muted ? mutedValueText : this.getValueTextParams(state).percent;
	}
	getValueTextParams(state) {
		return { percent: formatPercent(state.value / 100, this.#formatLocale) };
	}
	getAttrs(state) {
		return {
			...super.getAttrs(state),
			"aria-valuetext": this.getValueText(state)
		};
	}
};

//#endregion
//#region ../core/dist/default/core/ui/volume-slider/volume-slider-data-attrs.js
const VolumeSliderDataAttrs = {
	...SliderDataAttrs,
	availability: "data-availability",
	hidden: "data-hidden"
};

//#endregion
//#region ../html/dist/default/ui/airplay-button/airplay-button-element.js
var AirPlayButtonElement = class extends MediaButtonElement {
	constructor(..._args) {
		super(..._args);
		this.core = new AirPlayButtonCore();
		this.stateAttrMap = AirPlayButtonDataAttrs;
		this.mediaState = new PlayerController(this, playerContext, selectRemotePlayback);
	}
	static {
		this.tagName = "media-airplay-button";
	}
	activate(state) {
		this.core.toggle(state);
	}
};

//#endregion
//#region ../html/dist/default/ui/radio-group/context.js
const radioGroupContext = n(Symbol("@videojs/radio-group"));

//#endregion
//#region ../html/dist/default/ui/radio-group/radio-group-element.js
var RadioGroupElement = class extends MediaElement {
	constructor(..._args) {
		super(..._args);
		this.value = "";
		this.#provider = new i(this, { context: radioGroupContext });
	}
	static {
		this.properties = { value: { type: String } };
	}
	#provider;
	update(changed) {
		super.update(changed);
		this.#provider.setValue({
			value: this.value,
			onValueChange: (next) => {
				this.value = next;
				this.dispatchEvent(new CustomEvent("value-change", {
					detail: { value: next },
					bubbles: true
				}));
			}
		});
	}
};

//#endregion
//#region ../html/dist/default/ui/menu/context.js
const MENU_CONTEXT_KEY = Symbol("@videojs/menu");
const MENU_GROUP_CONTEXT_KEY = Symbol("@videojs/menu-group");
const menuContext = n(MENU_CONTEXT_KEY);
const menuGroupContext = n(MENU_GROUP_CONTEXT_KEY);

//#endregion
//#region ../html/dist/default/ui/menu/menu-group-controller.js
var MenuGroupController = class {
	#host;
	#provider;
	#contextValue = { registerLabel: (id) => this.#registerLabel(id) };
	#labelId;
	#appliedLabelId;
	constructor(host) {
		this.#host = host;
		this.#provider = new i(host, {
			context: menuGroupContext,
			initialValue: this.#contextValue
		});
	}
	applyProps() {
		const currentLabelledBy = this.#host.getAttribute("aria-labelledby") ?? void 0;
		const hasExplicitLabelledBy = currentLabelledBy !== void 0 && currentLabelledBy !== this.#appliedLabelId;
		if (this.#host.hasAttribute("aria-label") || hasExplicitLabelledBy) {
			if (this.#appliedLabelId && currentLabelledBy === this.#appliedLabelId) this.#host.removeAttribute("aria-labelledby");
			this.#appliedLabelId = void 0;
			applyElementProps(this.#host, { role: "group" });
			return;
		}
		this.#appliedLabelId = this.#labelId;
		applyElementProps(this.#host, {
			role: "group",
			"aria-labelledby": this.#labelId
		});
	}
	#registerLabel(id) {
		this.#labelId = id;
		this.#provider.setValue(this.#contextValue);
		this.#host.requestUpdate();
		return () => {
			if (this.#labelId !== id) return;
			this.#labelId = void 0;
			this.#host.requestUpdate();
		};
	}
};

//#endregion
//#region ../html/dist/default/ui/menu/menu-radio-item-element.js
var MenuRadioItemElement = class extends MediaElement {
	constructor(..._args) {
		super(..._args);
		this.value = "";
		this.disabled = false;
		this.#menuCtx = new s$1(this, {
			context: menuContext,
			subscribe: true
		});
		this.#groupCtx = new s$1(this, {
			context: radioGroupContext,
			subscribe: true
		});
		this.#disconnect = null;
		this.#registered = false;
		this.#cleanupRegistration = null;
	}
	static {
		this.tagName = "media-menu-radio-item";
	}
	static {
		this.properties = {
			value: { type: String },
			disabled: { type: Boolean }
		};
	}
	#menuCtx;
	#groupCtx;
	#disconnect;
	#registered;
	#cleanupRegistration;
	connectedCallback() {
		super.connectedCallback();
		this.#disconnect = new AbortController();
		this.#registered = false;
	}
	disconnectedCallback() {
		super.disconnectedCallback();
		this.#cleanupRegistration?.();
		this.#cleanupRegistration = null;
		this.#disconnect?.abort();
		this.#disconnect = null;
		this.#registered = false;
	}
	update(_changed) {
		super.update(_changed);
		const menuCtx = this.#menuCtx.value;
		const groupCtx = this.#groupCtx.value;
		if (!menuCtx || !groupCtx || !this.#disconnect) return;
		if (!this.#registered) {
			this.#registered = true;
			this.#cleanupRegistration = menuCtx.menu.registerItem(this);
			applyElementProps(this, {
				onClick: () => {
					const currentMenuCtx = this.#menuCtx.value;
					const currentGroupCtx = this.#groupCtx.value;
					if (!currentMenuCtx || !currentGroupCtx || this.disabled) return;
					currentGroupCtx.onValueChange(this.value);
					completeMenuItemSelection(currentMenuCtx.menu);
				},
				onPointerenter: () => {
					const currentMenuCtx = this.#menuCtx.value;
					if (!this.disabled) currentMenuCtx?.menu.highlight(this, { focus: false });
				}
			}, { signal: this.#disconnect.signal });
		}
		const checked = groupCtx.value === this.value;
		applyElementProps(this, {
			role: "menuitemradio",
			"aria-checked": String(checked),
			"aria-disabled": this.disabled ? "true" : void 0
		});
	}
};

//#endregion
//#region ../html/dist/default/ui/menu/menu-radio-group-element.js
var MenuRadioGroupElement = class extends RadioGroupElement {
	static {
		this.tagName = "media-menu-radio-group";
	}
	#group = new MenuGroupController(this);
	#menu = new s$1(this, {
		context: menuContext,
		subscribe: true
	});
	#ariaLabel = null;
	#metadataMenu = null;
	#setTriggerMetadata = null;
	disconnectedCallback() {
		this.#clearMenuMetadata();
		super.disconnectedCallback();
	}
	update(changed) {
		super.update(changed);
		this.#group.applyProps();
	}
	setItemLabel(item, label) {
		const labelPart = item.querySelector("[data-part~=\"label\"]");
		if (labelPart) labelPart.textContent = label;
		else item.textContent = label;
	}
	/** Applies a generated fallback without replacing an author-provided accessible name. */
	applyDefaultAriaLabel(label) {
		if (this.hasAttribute("aria-labelledby")) return;
		const current = this.getAttribute("aria-label");
		if (current !== null && current !== this.#ariaLabel) return;
		this.#ariaLabel = label;
		this.setAttribute("aria-label", label);
	}
	publishMenuMetadata(disabled, availability) {
		const context = this.#menu.value ?? null;
		if (context?.menu !== this.#metadataMenu) {
			this.#clearMenuMetadata();
			this.#metadataMenu = context?.menu ?? null;
			this.#setTriggerMetadata = context?.setTriggerMetadata ?? null;
		}
		if (!this.#setTriggerMetadata) return;
		const selectedItem = findElementChild(this, (item) => item instanceof MenuRadioItemElement && item.value === this.value);
		const hint = selectedItem?.querySelector("[data-part~=\"label\"]")?.textContent ?? selectedItem?.textContent?.trim() ?? "";
		this.#setTriggerMetadata({
			hint,
			disabled,
			availability
		});
	}
	#clearMenuMetadata() {
		this.#setTriggerMetadata?.({
			hint: "",
			disabled: false
		});
		this.#metadataMenu = null;
		this.#setTriggerMetadata = null;
	}
};

//#endregion
//#region ../html/dist/default/i18n/cache-key.js
/** Serialize text content and parameters so dynamic labels invalidate their caches. */
function cacheKey(text, params) {
	return JSON.stringify([text, params]);
}

//#endregion
//#region ../html/dist/default/ui/menu/menu-item-indicator-element.js
var MenuItemIndicatorElement = class extends MediaElement {
	constructor(..._args) {
		super(..._args);
		this.checked = false;
		this.forceMount = false;
	}
	static {
		this.tagName = "media-menu-item-indicator";
	}
	static {
		this.properties = {
			checked: { type: Boolean },
			forceMount: {
				type: Boolean,
				attribute: "force-mount"
			}
		};
	}
	update(_changed) {
		super.update(_changed);
		const hidden = !this.checked && !this.forceMount;
		applyElementProps(this, {
			"aria-hidden": "true",
			hidden
		});
	}
};

//#endregion
//#region ../html/dist/default/ui/radio-options/radio-options-controller.js
/** Renders normalized options into menu radio items and manages their interaction lifecycle. */
var RadioOptionsController = class {
	#host;
	#config;
	#contentKey = "";
	#translator = null;
	#disconnect = null;
	constructor(host, config) {
		this.#host = host;
		this.#config = config;
		host.addController(this);
	}
	hostConnected() {
		this.#disconnect = new AbortController();
		this.#host.addEventListener("value-change", this.#handleValueChange, { signal: this.#disconnect.signal });
	}
	hostDisconnected() {
		this.#disconnect?.abort();
		this.#disconnect = null;
	}
	hostDestroyed() {
		this.hostDisconnected();
	}
	sync(state, translator, locale) {
		this.#host.value = state.value;
		applyElementProps(this.#host, {
			"aria-disabled": state.disabled ? "true" : void 0,
			hidden: state.hidden ? "" : void 0
		});
		const template = getTemplateElement(this.#host);
		const templateRoot = template ? getTemplateRoot(template) : null;
		const itemRoot = templateRoot?.localName === MenuRadioItemElement.tagName ? templateRoot : null;
		const contentKey = `${state.options.map((option) => `${option.value}:${cacheKey(option.label, option.labelParams)}:${this.#config.getOptionCacheKey?.(option) ?? ""}`).join("|")}::${locale}::${template?.innerHTML ?? ""}`;
		if (contentKey !== this.#contentKey || translator !== this.#translator) {
			this.#contentKey = contentKey;
			this.#translator = translator;
			for (const child of [...this.#host.children]) {
				if (child === template) continue;
				child.remove();
			}
			const items = state.options.map((option) => {
				const item = itemRoot ? cloneTemplateRoot(itemRoot, this.#host.ownerDocument) : this.#host.ownerDocument.createElement(MenuRadioItemElement.tagName);
				item.value = option.value;
				this.#config.setItemAttributes?.(item, option);
				const label = translateText(option.label, translator, option.labelParams);
				if (this.#config.renderItem) this.#config.renderItem(item, label, option);
				else this.#setItemLabel(item, label);
				return item;
			});
			this.#host.append(...items);
		}
		const optionsByValue = new Map(state.options.map((option) => [option.value, option]));
		for (const item of this.#host.querySelectorAll(MenuRadioItemElement.tagName)) {
			const checked = item.value === state.value;
			const option = optionsByValue.get(item.value);
			item.disabled = state.disabled || option?.disabled === true;
			for (const indicator of item.querySelectorAll(MenuItemIndicatorElement.tagName)) indicator.checked = checked;
		}
	}
	#handleValueChange = (event) => {
		if (event.target !== this.#host) return;
		const { value } = event.detail;
		this.#config.onValueChange(value);
	};
	#setItemLabel(item, label) {
		const labelPart = item.querySelector("[data-part~=\"label\"]");
		if (labelPart) labelPart.textContent = label;
		else item.textContent = label;
	}
};

//#endregion
//#region ../html/dist/default/ui/audio-track-radio-group/audio-track-radio-group-element.js
var AudioTrackRadioGroupElement = class extends MenuRadioGroupElement {
	constructor(..._args) {
		super(..._args);
		this.disabled = false;
		this.label = "";
		this.formatTrack = AudioTrackRadioGroupCore.defaultProps.formatTrack;
		this.#core = new AudioTrackRadioGroupCore();
		this.#i18n = new I18nController(this, i18nContext);
		this.#mediaState = new PlayerController(this, playerContext, selectAudioTrack);
		this.#options = new RadioOptionsController(this, {
			setItemAttributes: (item, option) => item.setAttribute("data-track", option.value),
			onValueChange: (value) => {
				const media = this.#mediaState.value;
				if (media) this.#core.selectValue(media, value);
			}
		});
	}
	static {
		this.tagName = "media-audio-track-radio-group";
	}
	static {
		this.properties = {
			...MenuRadioGroupElement.properties,
			disabled: { type: Boolean },
			label: { type: String }
		};
	}
	#core;
	#i18n;
	#mediaState;
	#options;
	connectedCallback() {
		super.connectedCallback();
		if (this.destroyed) return;
	}
	update(changed) {
		const media = this.#mediaState.value;
		let state = null;
		if (media) {
			this.#core.setProps({
				formatTrack: this.formatTrack,
				disabled: this.disabled,
				label: this.label
			});
			this.#core.setMedia(media);
			state = this.#core.getState();
			this.applyDefaultAriaLabel(translateText(this.#core.getLabel(state), this.#i18n.value));
			this.#options.sync(state, this.#i18n.value, this.#i18n.locale);
			this.publishMenuMetadata(state.disabled, state.availability);
		}
		super.update(changed);
		if (state) applyStateDataAttrs(this, state, AudioTrackRadioGroupDataAttrs);
	}
};

//#endregion
//#region ../html/dist/default/ui/buffering-indicator/buffering-indicator-element.js
var BufferingIndicatorElement = class extends MediaElement {
	constructor(..._args) {
		super(..._args);
		this.delay = BufferingIndicatorCore.defaultProps.delay;
		this.#core = new BufferingIndicatorCore();
		this.#state = new PlayerController(this, playerContext, selectPlayback);
		this.#disconnect = null;
	}
	static {
		this.tagName = "media-buffering-indicator";
	}
	static {
		this.properties = { delay: { type: Number } };
	}
	#core;
	#state;
	#disconnect;
	connectedCallback() {
		super.connectedCallback();
		if (this.destroyed) return;
		this.#disconnect = new AbortController();
		this.#core.state.subscribe(() => this.requestUpdate(), { signal: this.#disconnect.signal });
	}
	disconnectedCallback() {
		super.disconnectedCallback();
		this.#disconnect?.abort();
		this.#disconnect = null;
	}
	willUpdate(changed) {
		super.willUpdate(changed);
		this.#core.setProps(this);
	}
	update(changed) {
		super.update(changed);
		const media = this.#state.value;
		if (!media) return;
		this.#core.update(media);
		applyStateDataAttrs(this, this.#core.state.current, BufferingIndicatorDataAttrs);
	}
};

//#endregion
//#region ../html/dist/default/ui/command-for.js
/** Toggle a popup host linked via `commandfor` (menu, popover, etc.). */
function toggleCommandTarget(host, commandfor) {
	const root = host.getRootNode();
	const target = ("getElementById" in root ? root.getElementById(commandfor) : null) ?? root.querySelector(`#${CSS.escape(commandfor)}`);
	if (!target || !("open" in target)) return;
	const popup = target;
	popup.open = !popup.open;
}

//#endregion
//#region ../html/dist/default/ui/captions-button/captions-button-element.js
function getCaptionTrackCount(state) {
	return state.textTrackList.filter(isCaptionOrSubtitleTrack).length;
}
var CaptionsButtonElement = class extends MediaButtonElement {
	constructor(..._args) {
		super(..._args);
		this.commandfor = void 0;
		this.menuFor = void 0;
		this.#defaultCommandfor = void 0;
		this.core = new CaptionsButtonCore();
		this.stateAttrMap = CaptionsButtonDataAttrs;
		this.mediaState = new PlayerController(this, playerContext, selectTextTrack);
		this.hotkeyAction = "toggleSubtitles";
	}
	static {
		this.tagName = "media-captions-button";
	}
	static {
		this.properties = {
			label: { type: String },
			disabled: { type: Boolean },
			commandfor: { type: String },
			menuFor: {
				type: String,
				attribute: "menu-for"
			}
		};
	}
	#defaultCommandfor;
	connectedCallback() {
		super.connectedCallback();
		if (this.commandfor && this.commandfor !== this.menuFor) this.#defaultCommandfor = this.commandfor;
	}
	activate(state, event) {
		if (this.menuFor && getCaptionTrackCount(state) > 1) {
			if (event instanceof KeyboardEvent) toggleCommandTarget(this, this.menuFor);
			return;
		}
		this.core.toggle(state);
	}
	getIsButtonDisabled() {
		const media = this.mediaState.value;
		if (super.getIsButtonDisabled()) return true;
		if (media && getCaptionTrackCount(media) === 0) return true;
		return false;
	}
	willUpdate(changed) {
		super.willUpdate(changed);
		if (changed.has("commandfor") && this.commandfor !== this.menuFor) this.#defaultCommandfor = this.commandfor;
		if (changed.has("commandfor") || changed.has("menuFor")) this.#syncCommandFor();
	}
	update(changed) {
		super.update(changed);
		const media = this.mediaState.value;
		if (!media) return;
		this.#syncCommandFor(media);
		if (this.menuFor && getCaptionTrackCount(media) > 1) applyElementProps(this, { "aria-disabled": this.getIsButtonDisabled() ? "true" : void 0 });
	}
	#syncCommandFor(media) {
		const state = media ?? this.mediaState.value;
		const target = state && this.menuFor && getCaptionTrackCount(state) > 1 ? this.menuFor : this.#defaultCommandfor;
		if (target) this.setAttribute("commandfor", target);
		else this.removeAttribute("commandfor");
	}
};

//#endregion
//#region ../html/dist/default/ui/captions-radio-group/captions-radio-group-element.js
var CaptionsRadioGroupElement = class extends MenuRadioGroupElement {
	constructor(..._args) {
		super(..._args);
		this.disabled = false;
		this.label = "";
		this.formatTrack = CaptionsRadioGroupCore.defaultProps.formatTrack;
		this.#core = new CaptionsRadioGroupCore();
		this.#i18n = new I18nController(this, i18nContext);
		this.#mediaState = new PlayerController(this, playerContext, selectTextTrack);
		this.#options = new RadioOptionsController(this, {
			setItemAttributes: (item, option) => item.setAttribute("data-track", option.value),
			onValueChange: (value) => {
				const media = this.#mediaState.value;
				if (media) this.#core.selectValue(media, value);
			}
		});
	}
	static {
		this.tagName = "media-captions-radio-group";
	}
	static {
		this.properties = {
			...MenuRadioGroupElement.properties,
			disabled: { type: Boolean },
			label: { type: String }
		};
	}
	#core;
	#i18n;
	#mediaState;
	#options;
	connectedCallback() {
		super.connectedCallback();
		if (this.destroyed) return;
	}
	update(changed) {
		const media = this.#mediaState.value;
		let state = null;
		if (media) {
			this.#core.setProps({
				formatTrack: this.formatTrack,
				disabled: this.disabled,
				label: this.label
			});
			this.#core.setMedia(media);
			state = this.#core.getState();
			this.applyDefaultAriaLabel(translateText(this.#core.getLabel(state), this.#i18n.value));
			this.#options.sync(state, this.#i18n.value, this.#i18n.locale);
			this.publishMenuMetadata(state.disabled, state.availability);
		}
		super.update(changed);
		if (state) applyStateDataAttrs(this, state, CaptionsRadioGroupDataAttrs);
	}
};

//#endregion
//#region ../html/dist/default/ui/cast-button/cast-button-element.js
var CastButtonElement = class extends MediaButtonElement {
	constructor(..._args) {
		super(..._args);
		this.core = new CastButtonCore();
		this.stateAttrMap = CastButtonDataAttrs;
		this.mediaState = new PlayerController(this, playerContext, selectRemotePlayback);
	}
	static {
		this.tagName = "media-cast-button";
	}
	activate(state) {
		return this.core.toggle(state);
	}
};

//#endregion
//#region ../html/dist/default/ui/fullscreen-button/fullscreen-button-element.js
var FullscreenButtonElement = class extends MediaButtonElement {
	constructor(..._args) {
		super(..._args);
		this.core = new FullscreenButtonCore();
		this.stateAttrMap = FullscreenButtonDataAttrs;
		this.mediaState = new PlayerController(this, playerContext, selectFullscreen);
		this.hotkeyAction = "toggleFullscreen";
	}
	static {
		this.tagName = "media-fullscreen-button";
	}
	activate(state) {
		return this.core.toggle(state);
	}
};

//#endregion
//#region ../html/dist/default/ui/gesture/gesture-element.js
var GestureElement = class extends MediaElement {
	constructor(..._args) {
		super(..._args);
		this.type = "";
		this.action = "";
		this.value = void 0;
		this.pointer = void 0;
		this.region = void 0;
		this.disabled = false;
		this.#player = new PlayerController(this, playerContext);
		this.#container = new s$1(this, {
			context: containerContext,
			callback: () => this.requestUpdate(),
			subscribe: true
		});
		this.#cleanup = null;
	}
	static {
		this.tagName = "media-gesture";
	}
	static {
		this.properties = {
			type: { type: String },
			action: { type: String },
			value: { type: Number },
			pointer: { type: String },
			region: { type: String },
			disabled: { type: Boolean }
		};
	}
	#player;
	#container;
	#cleanup;
	connectedCallback() {
		super.connectedCallback();
		this.style.display = "none";
		this.#register();
	}
	disconnectedCallback() {
		super.disconnectedCallback();
		this.#unregister();
	}
	update(changed) {
		super.update(changed);
		if (this.isConnected) {
			this.#unregister();
			this.#register();
		}
	}
	#register() {
		const store = this.#player.value;
		const container = this.#container.value?.container;
		if (!this.type || !this.action || !store || !container) return;
		const resolver = resolveGestureAction(this.action);
		if (!resolver) return;
		const { value } = this;
		const onActivate = (event) => {
			resolver({
				store,
				value,
				event
			});
		};
		const options = {
			pointer: this.pointer,
			region: this.region,
			disabled: this.disabled,
			action: this.action,
			value: this.value
		};
		if (this.type === "doubletap") this.#cleanup = createDoubleTapGesture(container, onActivate, options);
		else this.#cleanup = createTapGesture(container, onActivate, options);
	}
	#unregister() {
		this.#cleanup?.();
		this.#cleanup = null;
	}
};

//#endregion
//#region ../html/dist/default/ui/hotkey/hotkey-element.js
var HotkeyElement = class extends MediaElement {
	constructor(..._args) {
		super(..._args);
		this.keys = "";
		this.action = "";
		this.value = void 0;
		this.disabled = false;
		this.target = "player";
		this.#player = new PlayerController(this, playerContext);
		this.#container = new s$1(this, {
			context: containerContext,
			callback: () => this.requestUpdate(),
			subscribe: true
		});
		this.#cleanup = null;
	}
	static {
		this.tagName = "media-hotkey";
	}
	static {
		this.properties = {
			keys: { type: String },
			action: { type: String },
			value: { type: Number },
			disabled: { type: Boolean },
			target: { type: String }
		};
	}
	#player;
	#container;
	#cleanup;
	connectedCallback() {
		super.connectedCallback();
		this.style.display = "none";
		this.#register();
	}
	disconnectedCallback() {
		super.disconnectedCallback();
		this.#unregister();
	}
	update(changed) {
		super.update(changed);
		if (this.isConnected) {
			this.#unregister();
			this.#register();
		}
	}
	#register() {
		const store = this.#player.value;
		const container = this.#container.value?.container;
		if (!this.keys || !this.action || !store || !container) return;
		const resolver = resolveHotkeyAction(this.action);
		if (!resolver) return;
		const { value, action } = this;
		this.#cleanup = createHotkey(container, {
			keys: this.keys,
			action,
			value,
			target: this.target,
			disabled: this.disabled,
			repeatable: !isHotkeyToggleAction(action),
			onActivate: (_event, key) => {
				resolver({
					store,
					key,
					value
				});
			}
		});
	}
	#unregister() {
		this.#cleanup?.();
		this.#cleanup = null;
	}
};

//#endregion
//#region ../html/dist/default/ui/live-button/live-button-element.js
/**
* `<media-live-button>` — selects from `live`, `time`, and `buffer` features
* and composes them into the `LiveButtonMediaState` consumed by
* `LiveButtonCore`.
*
* Doesn't extend `MediaButtonElement` because that base couples a button to
* a single feature selector; the LiveButton needs three.
*/
var LiveButtonElement = class extends MediaElement {
	constructor(..._args) {
		super(..._args);
		this.disabled = false;
		this.label = "";
		this.core = new LiveButtonCore();
		this.live = new PlayerController(this, playerContext, selectLive);
		this.time = new PlayerController(this, playerContext, selectTime);
		this.buffer = new PlayerController(this, playerContext, selectBuffer);
		this.#i18n = new I18nController(this, i18nContext);
		this.#defaultContent = false;
		this.#disconnect = null;
	}
	static {
		this.tagName = "media-live-button";
	}
	static {
		this.properties = {
			label: { type: String },
			disabled: { type: Boolean }
		};
	}
	#i18n;
	get $state() {
		return this.core.state;
	}
	#defaultContent;
	#disconnect;
	connectedCallback() {
		super.connectedCallback();
		if (this.destroyed) return;
		this.#defaultContent ||= !this.textContent?.trim();
		if (this.#defaultContent) this.textContent = translateText(LiveButtonCore.defaultText, this.#i18n.value);
		this.#disconnect = new AbortController();
		const buttonProps = createButton({
			onActivate: () => {
				const media = this.#getMedia();
				if (media) this.core.seekToLive(media);
			},
			isDisabled: () => this.disabled || !this.#getMedia()
		});
		applyElementProps(this, buttonProps, { signal: this.#disconnect.signal });
	}
	disconnectedCallback() {
		super.disconnectedCallback();
		this.#disconnect?.abort();
		this.#disconnect = null;
	}
	/** Returns the button's current label derived from media state. */
	getLabel() {
		return this.core.state.current.label ? resolveText(this.core.state.current.label) : void 0;
	}
	/** Resolved label for tooltips and other display surfaces. */
	getResolvedLabel() {
		if (!this.#getMedia()) return void 0;
		const state = this.core.getState();
		return translateText(this.core.getLabel(state), this.#i18n.value);
	}
	willUpdate(changed) {
		super.willUpdate(changed);
		this.core.setProps(this);
	}
	update(changed) {
		super.update(changed);
		if (this.#defaultContent) this.textContent = translateText(LiveButtonCore.defaultText, this.#i18n.value);
		const media = this.#getMedia();
		if (!media) return;
		this.core.setMedia(media);
		const state = this.core.getState();
		const attrs = this.core.getAttrs(state);
		applyElementProps(this, {
			...attrs,
			"aria-label": translateText(attrs["aria-label"], this.#i18n.value)
		});
		applyStateDataAttrs(this, state, LiveButtonDataAttrs);
	}
	/**
	* Compose the LiveButton media state from the three feature slices.
	* Returns `null` when any are missing so the button stays disabled until
	* all three features are registered on the player.
	*/
	#getMedia() {
		const live = this.live.value;
		const time = this.time.value;
		const buffer = this.buffer.value;
		if (!live || !time || !buffer) return null;
		return {
			currentTime: time.currentTime,
			seek: time.seek,
			seekable: buffer.seekable,
			liveEdgeStart: live.liveEdgeStart,
			targetLiveWindow: live.targetLiveWindow
		};
	}
};

//#endregion
//#region ../html/dist/default/ui/mute-button/mute-button-element.js
var MuteButtonElement = class extends MediaButtonElement {
	constructor(..._args) {
		super(..._args);
		this.core = new MuteButtonCore();
		this.stateAttrMap = MuteButtonDataAttrs;
		this.mediaState = new PlayerController(this, playerContext, selectVolume);
		this.hotkeyAction = "toggleMuted";
	}
	static {
		this.tagName = "media-mute-button";
	}
	activate(state) {
		this.core.toggle(state);
	}
};

//#endregion
//#region ../html/dist/default/ui/pip-button/pip-button-element.js
var PiPButtonElement = class extends MediaButtonElement {
	constructor(..._args) {
		super(..._args);
		this.core = new PiPButtonCore();
		this.stateAttrMap = PiPButtonDataAttrs;
		this.mediaState = new PlayerController(this, playerContext, selectPiP);
		this.hotkeyAction = "togglePictureInPicture";
	}
	static {
		this.tagName = "media-pip-button";
	}
	activate(state) {
		return this.core.toggle(state);
	}
};

//#endregion
//#region ../html/dist/default/ui/play-button/play-button-element.js
var PlayButtonElement = class extends MediaButtonElement {
	constructor(..._args) {
		super(..._args);
		this.core = new PlayButtonCore();
		this.stateAttrMap = PlayButtonDataAttrs;
		this.mediaState = new PlayerController(this, playerContext, selectPlayback);
		this.hotkeyAction = "togglePaused";
	}
	static {
		this.tagName = "media-play-button";
	}
	activate(state) {
		this.core.toggle(state);
	}
};

//#endregion
//#region ../html/dist/default/ui/playback-rate-button/playback-rate-button-element.js
var PlaybackRateButtonElement = class extends MediaButtonElement {
	constructor(..._args) {
		super(..._args);
		this.commandfor = void 0;
		this.core = new PlaybackRateButtonCore();
		this.stateAttrMap = PlaybackRateButtonDataAttrs;
		this.mediaState = new PlayerController(this, playerContext, selectPlaybackRate);
		this.hotkeyAction = "speedUp";
	}
	static {
		this.tagName = "media-playback-rate-button";
	}
	static {
		this.properties = {
			label: { type: String },
			disabled: { type: Boolean },
			commandfor: { type: String }
		};
	}
	activate(state, event) {
		if (this.commandfor) {
			if (event instanceof KeyboardEvent) toggleCommandTarget(this, this.commandfor);
			return;
		}
		this.core.cycle(state);
	}
	getIsButtonDisabled() {
		const media = this.mediaState.value;
		if (super.getIsButtonDisabled()) return true;
		if (this.commandfor && media && media.playbackRates.length === 0) return true;
		return false;
	}
	willUpdate(changed) {
		super.willUpdate(changed);
		if (changed.has("commandfor")) if (this.commandfor) this.setAttribute("commandfor", this.commandfor);
		else this.removeAttribute("commandfor");
	}
	update(changed) {
		super.update(changed);
		if (!this.mediaState.value || !this.commandfor) return;
		applyElementProps(this, { "aria-disabled": this.getIsButtonDisabled() ? "true" : void 0 });
	}
};

//#endregion
//#region ../html/dist/default/ui/playback-rate-radio-group/playback-rate-radio-group-element.js
var PlaybackRateRadioGroupElement = class extends MenuRadioGroupElement {
	constructor(..._args) {
		super(..._args);
		this.disabled = false;
		this.formatRate = PlaybackRateRadioGroupCore.defaultProps.formatRate;
		this.#core = new PlaybackRateRadioGroupCore();
		this.#i18n = new I18nController(this, i18nContext);
		this.#mediaState = new PlayerController(this, playerContext, selectPlaybackRate);
		this.#options = new RadioOptionsController(this, {
			setItemAttributes: (item, option) => item.setAttribute("data-rate", option.value),
			onValueChange: (value) => {
				const media = this.#mediaState.value;
				if (media) this.#core.selectValue(media, value);
			}
		});
	}
	static {
		this.tagName = "media-playback-rate-radio-group";
	}
	static {
		this.properties = {
			...MenuRadioGroupElement.properties,
			disabled: { type: Boolean }
		};
	}
	#core;
	#i18n;
	#mediaState;
	#options;
	connectedCallback() {
		super.connectedCallback();
		if (this.destroyed) return;
	}
	update(changed) {
		const media = this.#mediaState.value;
		let state = null;
		if (media) {
			this.#core.setProps({
				formatRate: this.formatRate,
				disabled: this.disabled
			});
			this.#core.setMedia(media);
			state = this.#core.getState();
			this.applyDefaultAriaLabel(translateText(this.#core.getLabel(state), this.#i18n.value, this.#core.getLabelParams(state)));
			this.#options.sync(state, this.#i18n.value, this.#i18n.locale);
			this.publishMenuMetadata(state.disabled, state.availability);
		}
		super.update(changed);
		if (state) applyStateDataAttrs(this, state, PlaybackRateRadioGroupDataAttrs);
	}
};

//#endregion
//#region ../html/dist/default/ui/position-controller.js
let popupId = 0;
/** Connects a popup element to the shared positioning lifecycle. */
var PositionController = class {
	#host;
	#positioner = new PopupPositioner();
	#implicitBinding = null;
	constructor(host) {
		this.#host = host;
		host.addController(this);
	}
	/** Discover an explicit trigger by ID or one linked via `commandfor`. */
	findTrigger(trigger) {
		const root = this.#host.getRootNode();
		if (trigger) {
			this.#releaseImplicitBinding();
			return root.getElementById(trigger);
		}
		if (this.#implicitBinding) {
			const { id, trigger: boundTrigger } = this.#implicitBinding;
			if (this.#host.id === id && boundTrigger.getAttribute("commandfor") === id && this.#host.previousElementSibling === boundTrigger) return boundTrigger;
			this.#releaseImplicitBinding();
		}
		if (this.#host.id) return root.querySelector(`[commandfor="${this.#host.id}"]`);
		const adjacent = this.#host.previousElementSibling;
		if (!(adjacent instanceof HTMLElement)) return null;
		if (adjacent.getAttribute("commandfor")) return null;
		const id = nextPopupId(root);
		this.#host.id = id;
		adjacent.setAttribute("commandfor", id);
		this.#implicitBinding = {
			id,
			trigger: adjacent
		};
		return adjacent;
	}
	sync(options) {
		this.#positioner.sync({
			...options,
			popup: this.#host
		});
	}
	cleanup() {
		this.#positioner.cleanup();
	}
	hostDisconnected() {
		this.cleanup();
		this.#releaseImplicitBinding();
	}
	hostDestroyed() {
		this.cleanup();
		this.#releaseImplicitBinding();
	}
	#releaseImplicitBinding() {
		const binding = this.#implicitBinding;
		if (!binding) return;
		if (binding.trigger.getAttribute("commandfor") === binding.id) binding.trigger.removeAttribute("commandfor");
		if (this.#host.id === binding.id) this.#host.removeAttribute("id");
		this.#implicitBinding = null;
	}
};
function nextPopupId(root) {
	let id;
	do
		id = `vjs-popup-${++popupId}`;
	while (root.getElementById(id));
	return id;
}

//#endregion
//#region ../html/dist/default/ui/popover/popover-element.js
var PopoverElement = class extends MediaElement {
	constructor(..._args) {
		super(..._args);
		this.open = PopoverCore.defaultProps.open;
		this.defaultOpen = PopoverCore.defaultProps.defaultOpen;
		this.side = PopoverCore.defaultProps.side;
		this.align = PopoverCore.defaultProps.align;
		this.modal = PopoverCore.defaultProps.modal;
		this.closeOnEscape = PopoverCore.defaultProps.closeOnEscape;
		this.closeOnOutsideClick = PopoverCore.defaultProps.closeOnOutsideClick;
		this.openOnHover = PopoverCore.defaultProps.openOnHover;
		this.delay = PopoverCore.defaultProps.delay;
		this.closeDelay = PopoverCore.defaultProps.closeDelay;
		this.boundary = "container";
		this.#core = new PopoverCore();
		this.#containerCtx = new s$1(this, {
			context: containerContext,
			subscribe: true
		});
		this.#popupGroupCtx = new s$1(this, { context: popupGroupContext });
		this.#position = new PositionController(this);
		this.#popover = null;
		this.#snapshot = null;
		this.#disconnect = null;
		this.#triggerAbort = null;
		this.#currentTrigger = null;
	}
	static {
		this.tagName = "media-popover";
	}
	static {
		this.properties = {
			open: { type: Boolean },
			defaultOpen: {
				type: Boolean,
				attribute: "default-open"
			},
			side: { type: String },
			align: { type: String },
			modal: { type: Boolean },
			closeOnEscape: {
				type: Boolean,
				attribute: "close-on-escape"
			},
			closeOnOutsideClick: {
				type: Boolean,
				attribute: "close-on-outside-click"
			},
			openOnHover: {
				type: Boolean,
				attribute: "open-on-hover"
			},
			delay: { type: Number },
			closeDelay: {
				type: Number,
				attribute: "close-delay"
			},
			boundary: { type: String }
		};
	}
	#core;
	#containerCtx;
	#popupGroupCtx;
	#position;
	#popover;
	#snapshot;
	#disconnect;
	#triggerAbort;
	#currentTrigger;
	connectedCallback() {
		super.connectedCallback();
		if (this.destroyed) return;
		this.setAttribute(POPUP_HOST_ATTR, "");
		this.#disconnect = new AbortController();
		this.#popover = createPopover({
			transition: createTransition(),
			onOpenChange: (nextOpen, details) => {
				this.open = nextOpen;
				this.dispatchEvent(new CustomEvent("open-change", { detail: {
					open: nextOpen,
					...details
				} }));
			},
			closeOnEscape: () => this.closeOnEscape,
			closeOnOutsideClick: () => this.closeOnOutsideClick,
			openOnHover: () => this.openOnHover,
			delay: () => this.delay,
			closeDelay: () => this.closeDelay,
			group: () => this.#popupGroupCtx.value
		});
		this.#popover.setPopupElement(this);
		applyElementProps(this, this.#popover.popupProps, { signal: this.#disconnect.signal });
		if (this.#snapshot) this.#snapshot.track(this.#popover.input);
		else this.#snapshot = new SnapshotController(this, this.#popover.input);
	}
	firstUpdated(changed) {
		super.firstUpdated(changed);
		if (this.defaultOpen && !this.open) this.#popover?.open();
	}
	disconnectedCallback() {
		super.disconnectedCallback();
		this.#disconnect?.abort();
		this.#disconnect = null;
	}
	destroyCallback() {
		this.#cleanupTrigger();
		this.#popover?.destroy();
		super.destroyCallback();
	}
	close(reason = "imperative-action") {
		this.#popover?.close(reason);
	}
	willUpdate(changed) {
		super.willUpdate(changed);
		this.#core.setProps(this);
		if (this.#popover && changed.has("open")) {
			const { active: interactionOpen } = this.#popover.input.current;
			if (this.open !== interactionOpen) if (this.open) this.#popover.open();
			else this.#popover.close();
		}
	}
	update(_changed) {
		super.update(_changed);
		if (!this.#popover) return;
		const triggerEl = this.#position.findTrigger();
		this.#syncTrigger(triggerEl);
		const input = this.#popover.input.current;
		this.#core.setInput(input);
		const state = this.#core.getState();
		applyElementProps(this, this.#core.getPopupAttrs(state));
		applyStateDataAttrs(this, state, PopoverDataAttrs);
		if (state.open) tryShowPopover(this);
		else tryHidePopover(this);
		if (this.#currentTrigger) applyElementProps(this.#currentTrigger, this.#core.getTriggerAttrs(state, this.id));
		if (!state.open) {
			this.#position.cleanup();
			return;
		}
		this.#position.sync({
			anchorName: this.id,
			position: {
				side: state.side,
				align: state.align
			},
			trigger: this.#currentTrigger,
			boundary: this.boundary,
			container: this.#containerCtx.value?.container ?? null,
			onSideChange: (side) => this.setAttribute(PopoverDataAttrs.side, side)
		});
	}
	#syncTrigger(triggerEl) {
		if (triggerEl === this.#currentTrigger) return;
		this.#position.cleanup();
		this.#cleanupTrigger();
		this.#currentTrigger = triggerEl;
		this.#popover?.setTriggerElement(triggerEl);
		if (triggerEl && this.#popover) {
			this.#triggerAbort = new AbortController();
			applyElementProps(triggerEl, this.#popover.triggerProps, { signal: this.#triggerAbort.signal });
		}
	}
	#cleanupTrigger() {
		if (this.#currentTrigger) applyElementProps(this.#currentTrigger, {
			"aria-expanded": void 0,
			"aria-haspopup": void 0,
			"aria-controls": void 0
		});
		this.#triggerAbort?.abort();
		this.#triggerAbort = null;
		this.#currentTrigger = null;
	}
};

//#endregion
//#region ../html/dist/default/ui/media-ui-element.js
/** Abstract base for HTML custom elements that display media state with data attributes. */
var MediaUIElement = class extends MediaElement {
	#i18n = new I18nController(this, i18nContext);
	connectedCallback() {
		super.connectedCallback();
	}
	update(changed) {
		super.update(changed);
		const media = this.mediaState.value;
		if (!media) return;
		this.core.setMedia(media);
		const state = this.core.getState();
		if (isFunction(this.core.getAttrs)) {
			const attrs = this.core.getAttrs(state);
			if (isText(attrs["aria-label"])) attrs["aria-label"] = translateText(attrs["aria-label"], this.#i18n.value);
			applyElementProps(this, attrs);
		}
		applyStateDataAttrs(this, state, this.stateAttrMap);
	}
};

//#endregion
//#region ../html/dist/default/ui/poster/poster-element.js
var PosterElement = class extends MediaUIElement {
	constructor(..._args) {
		super(..._args);
		this.core = new PosterCore();
		this.stateAttrMap = PosterDataAttrs;
		this.mediaState = new PlayerController(this, playerContext, selectPlayback);
	}
	static {
		this.tagName = "media-poster";
	}
	static get observedAttributes() {
		return [...super.observedAttributes, "placeholdersrc"];
	}
	attributeChangedCallback(attr, oldValue, newValue) {
		super.attributeChangedCallback(attr, oldValue, newValue);
		if (attr === "placeholdersrc") if (newValue) this.style.setProperty("--media-poster-placeholder", `url(${newValue})`);
		else this.style.removeProperty("--media-poster-placeholder");
	}
};

//#endregion
//#region ../html/dist/default/ui/quality-radio-group/quality-radio-group-element.js
var QualityRadioGroupElement = class extends MenuRadioGroupElement {
	constructor(..._args) {
		super(..._args);
		this.disabled = false;
		this.label = "";
		this.formatRendition = QualityRadioGroupCore.defaultProps.formatRendition;
		this.#core = new QualityRadioGroupCore();
		this.#i18n = new I18nController(this, i18nContext);
		this.#mediaState = new PlayerController(this, playerContext, selectQuality);
		this.#options = new RadioOptionsController(this, {
			renderItem: (item, label, option) => this.#setContent(item, label, option.tier, option.badge),
			setItemAttributes: (item, option) => item.setAttribute("data-rendition", option.value),
			getOptionCacheKey: (option) => `${option.tier ?? ""}:${option.badge ?? ""}`,
			onValueChange: (value) => {
				const media = this.#mediaState.value;
				if (media) this.#core.selectValue(media, value);
			}
		});
	}
	static {
		this.tagName = "media-quality-radio-group";
	}
	static {
		this.properties = {
			...MenuRadioGroupElement.properties,
			disabled: { type: Boolean },
			label: { type: String }
		};
	}
	#core;
	#i18n;
	#mediaState;
	#options;
	connectedCallback() {
		super.connectedCallback();
		if (this.destroyed) return;
	}
	update(changed) {
		const media = this.#mediaState.value;
		let state = null;
		if (media) {
			this.#core.setProps({
				formatRendition: this.formatRendition,
				disabled: this.disabled,
				label: this.label
			});
			this.#core.setMedia(media);
			state = this.#core.getState();
			this.applyDefaultAriaLabel(translateText(this.#core.getLabel(state), this.#i18n.value));
			this.#options.sync(state, this.#i18n.value, this.#i18n.locale);
			this.publishMenuMetadata(state.disabled, state.availability);
		}
		super.update(changed);
		if (state) applyStateDataAttrs(this, state, QualityRadioGroupDataAttrs);
	}
	#setContent(item, label, tier, badge) {
		const labelPart = item.querySelector("[data-part~=\"label\"]");
		const tierPart = item.querySelector("[data-part~=\"tier\"]");
		const badgePart = item.querySelector("[data-part~=\"badge\"]");
		if (labelPart) labelPart.textContent = label;
		if (tierPart) {
			tierPart.textContent = tier ?? "";
			tierPart.hidden = !tier;
		}
		if (badgePart) {
			badgePart.textContent = badge ?? "";
			badgePart.hidden = !badge;
		}
		if (!labelPart && !tierPart && !badgePart) item.textContent = [
			label,
			tier,
			badge
		].filter(Boolean).join(" ");
	}
};

//#endregion
//#region ../html/dist/default/ui/seek-button/seek-button-element.js
var SeekButtonElement = class extends MediaButtonElement {
	constructor(..._args) {
		super(..._args);
		this.seconds = SeekButtonCore.defaultProps.seconds;
		this.core = new SeekButtonCore();
		this.stateAttrMap = SeekButtonDataAttrs;
		this.mediaState = new PlayerController(this, playerContext, selectTime);
		this.hotkeyAction = "seekStep";
	}
	static {
		this.tagName = "media-seek-button";
	}
	static {
		this.properties = {
			...MediaButtonElement.properties,
			seconds: { type: Number }
		};
	}
	get hotkeyValue() {
		return this.seconds;
	}
	activate(state) {
		this.core.seek(state);
	}
};

//#endregion
//#region ../html/dist/default/ui/slider/context.js
const sliderContext = n(Symbol("@videojs/slider"));

//#endregion
//#region ../html/dist/default/ui/time-slider/time-slider-chapters/time-slider-chapter-title-element.js
/** Displays the chapter title at the current pointer or keyboard position. */
var TimeSliderChapterTitleElement = class extends MediaElement {
	static {
		this.tagName = "media-time-slider-chapter-title";
	}
	#core = new TimeSliderChaptersCore();
	#slider = new s$1(this, {
		context: sliderContext,
		subscribe: true
	});
	#textTrack = new PlayerController(this, playerContext, selectTextTrack);
	#time = new PlayerController(this, playerContext, selectTime);
	update(_changed) {
		super.update(_changed);
		const slider = this.#slider.value;
		if (!slider) return;
		const duration = this.#time.value?.duration ?? 0;
		const { chapters } = this.#core.getRanges(this.#textTrack.value?.chaptersCues ?? [], 0, duration);
		const keyboard = slider.state.interactive && !slider.state.pointing && !slider.state.dragging;
		const value = slider.state.pointing || slider.state.dragging ? slider.pointerValue : slider.state.value;
		const chapter = this.#core.findChapter(chapters, value);
		this.textContent = chapter?.cue?.text ?? "";
		if (keyboard) {
			this.removeAttribute("aria-hidden");
			this.setAttribute("aria-live", "polite");
		} else {
			this.setAttribute("aria-hidden", "true");
			this.removeAttribute("aria-live");
		}
	}
};

//#endregion
//#region ../html/dist/default/ui/time-slider/time-slider-chapters/time-slider-chapters-element.js
/**
* Clones a light-DOM template once per normalized chapter range.
*
* The template must contain exactly one HTML root element. Non-template children remain visible when the template is
* missing or invalid, allowing consumers to provide a regular slider track as a fallback.
*/
var TimeSliderChaptersElement = class extends MediaElement {
	static {
		this.tagName = "media-time-slider-chapters";
	}
	#segments = new SliderSegmentsCore();
	#core = new TimeSliderChaptersCore();
	#slider = new s$1(this, {
		context: sliderContext,
		subscribe: true
	});
	#textTrack = new PlayerController(this, playerContext, selectTextTrack);
	#buffer = new PlayerController(this, playerContext, selectBuffer);
	#time = new PlayerController(this, playerContext, selectTime);
	#rendered = /* @__PURE__ */ new Map();
	#templateRoot = null;
	#templateChecked = false;
	connectedCallback() {
		super.connectedCallback();
		this.setAttribute("aria-hidden", "true");
	}
	update(_changed) {
		super.update(_changed);
		const slider = this.#slider.value;
		const duration = this.#time.value?.duration ?? 0;
		const templateRoot = this.#getTemplateRoot();
		if (!slider) return;
		applyStateDataAttrs(this, slider.state, slider.stateAttrMap);
		if (!templateRoot) return;
		const { chapters, ranges, max } = this.#core.getRanges(this.#textTrack.value?.chaptersCues ?? [], 0, duration);
		const geometry = this.#segments.getGeometry({
			ranges,
			min: 0,
			max,
			orientation: slider.state.orientation
		});
		const buffered = this.#buffer.value?.buffered ?? [];
		const bufferedEnd = buffered.length ? buffered[buffered.length - 1][1] : 0;
		const next = /* @__PURE__ */ new Map();
		for (const segment of geometry) {
			const state = this.#core.getState(this.#segments.getState(segment, slider.state, slider.pointerValue), chapters, bufferedEnd);
			let root = this.#rendered.get(state.key);
			if (!root) root = cloneTemplateRoot(templateRoot, this.ownerDocument);
			this.#setStyle(root, "pointer-events", state.cue ? void 0 : "none");
			this.#setStyle(root, TimeSliderChapterCSSVars.start, state.startPercent);
			this.#setStyle(root, TimeSliderChapterCSSVars.end, state.endPercent);
			this.#setStyle(root, TimeSliderChapterCSSVars.width, state.width ?? state.height);
			this.#setStyle(root, TimeSliderChapterCSSVars.fill, `${state.fillPercent}%`);
			this.#setStyle(root, TimeSliderChapterCSSVars.buffer, `${state.bufferPercent}%`);
			applyStateDataAttrs(root, slider.state, slider.stateAttrMap);
			applyStateDataAttrs(root, state, TimeSliderChapterDataAttrs);
			next.set(state.key, root);
		}
		for (const [key, root] of this.#rendered) if (!next.has(key)) root.remove();
		let before = null;
		for (const root of [...next.values()].reverse()) {
			if (root.parentNode !== this || root.nextSibling !== before) this.insertBefore(root, before);
			before = root;
		}
		this.#rendered.clear();
		for (const [key, rendered] of next) this.#rendered.set(key, rendered);
	}
	#getTemplateRoot() {
		if (this.#templateChecked) return this.#templateRoot;
		const template = getTemplateElement(this);
		if (!template) return null;
		this.#templateChecked = true;
		const root = getTemplateRoot(template);
		if (root?.namespaceURI !== "http://www.w3.org/1999/xhtml") return null;
		this.#templateRoot = root;
		for (const node of [...this.childNodes]) if (node !== template) node.remove();
		return this.#templateRoot;
	}
	#setStyle(element, name, value) {
		if (value === void 0) element.style.removeProperty(name);
		else element.style.setProperty(name, value);
	}
};

//#endregion
//#region ../html/dist/default/ui/alert-dialog/context.js
const alertDialogContext = n(Symbol("@videojs/alert-dialog"));

//#endregion
//#region ../html/dist/default/ui/alert-dialog/alert-dialog-close-element.js
var AlertDialogCloseElement = class extends MediaElement {
	constructor(..._args) {
		super(..._args);
		this.disabled = false;
		this.#ctx = new s$1(this, {
			context: alertDialogContext,
			subscribe: true
		});
		this.#disconnect = null;
	}
	static {
		this.tagName = "media-alert-dialog-close";
	}
	static {
		this.properties = { disabled: { type: Boolean } };
	}
	#ctx;
	#disconnect;
	connectedCallback() {
		super.connectedCallback();
		this.#disconnect = new AbortController();
		const buttonProps = createButton({
			onActivate: () => this.#ctx.value?.close(),
			isDisabled: () => this.disabled
		});
		applyElementProps(this, buttonProps, { signal: this.#disconnect.signal });
	}
	disconnectedCallback() {
		super.disconnectedCallback();
		this.#disconnect?.abort();
		this.#disconnect = null;
	}
	update(_changed) {
		super.update(_changed);
		const ctx = this.#ctx.value;
		if (ctx) applyStateDataAttrs(this, ctx.state, ctx.stateAttrMap);
	}
};

//#endregion
//#region ../html/dist/default/ui/context-part-element.js
/**
* Abstract base for compound-component part elements that consume a parent
* context and apply data attributes from `ctx.state` + `ctx.stateAttrMap`.
*
* Subclasses only need to declare the `consumer` property:
*
* ```ts
* export class SliderTrackElement extends ContextPartElement<SliderState> {
*   static readonly tagName = 'media-slider-track';
*   protected readonly consumer = new ContextConsumer(this, { context: sliderContext, subscribe: true });
* }
* ```
*/
var ContextPartElement = class extends MediaElement {
	connectedCallback() {
		super.connectedCallback();
		this.#applyState();
	}
	update(_changed) {
		super.update(_changed);
		this.#applyState();
	}
	#applyState() {
		const ctx = this.consumer.value;
		if (ctx) applyStateDataAttrs(this, ctx.state, ctx.stateAttrMap);
	}
};

//#endregion
//#region ../html/dist/default/ui/alert-dialog/alert-dialog-description-element.js
var AlertDialogDescriptionElement = class extends ContextPartElement {
	constructor(..._args) {
		super(..._args);
		this.consumer = new s$1(this, {
			context: alertDialogContext,
			subscribe: true
		});
	}
	static {
		this.tagName = "media-alert-dialog-description";
	}
	update(changed) {
		super.update(changed);
		const descriptionId = this.consumer.value?.state.descriptionId;
		if (descriptionId) this.id = descriptionId;
	}
};

//#endregion
//#region ../html/dist/default/ui/alert-dialog/alert-dialog-title-element.js
var AlertDialogTitleElement = class extends ContextPartElement {
	constructor(..._args) {
		super(..._args);
		this.consumer = new s$1(this, {
			context: alertDialogContext,
			subscribe: true
		});
	}
	static {
		this.tagName = "media-alert-dialog-title";
	}
	update(changed) {
		super.update(changed);
		const titleId = this.consumer.value?.state.titleId;
		if (titleId) this.id = titleId;
	}
};

//#endregion
//#region ../html/dist/default/ui/controls/context.js
const controlsContext = n(Symbol("@videojs/controls"));

//#endregion
//#region ../html/dist/default/ui/controls/controls-element.js
var ControlsElement = class extends MediaElement {
	static {
		this.tagName = "media-controls";
	}
	#core = new ControlsCore();
	#mediaState = new PlayerController(this, playerContext, selectControls);
	#provider = new i(this, { context: controlsContext });
	#visible = true;
	connectedCallback() {
		super.connectedCallback();
		this.setAttribute("data-interactive", "");
	}
	update(_changed) {
		super.update(_changed);
		const media = this.#mediaState.value;
		if (!media) return;
		this.#core.setMedia(media);
		const state = this.#core.getState();
		applyStateDataAttrs(this, state, ControlsDataAttrs);
		this.#provider.setValue({
			state,
			stateAttrMap: ControlsDataAttrs
		});
		const wasVisible = this.#visible;
		this.#visible = state.visible;
		if (wasVisible && !state.visible) this.#closeOwnedOverlays();
	}
	#closeOwnedOverlays() {
		for (const element of this.querySelectorAll(POPUP_HOST_SELECTOR)) {
			const host = element;
			if (!isFunction(host.close)) continue;
			host.close("imperative-action");
		}
	}
};

//#endregion
//#region ../html/dist/default/ui/controls/controls-group-element.js
var ControlsGroupElement = class extends ContextPartElement {
	constructor(..._args) {
		super(..._args);
		this.consumer = new s$1(this, {
			context: controlsContext,
			subscribe: true
		});
	}
	static {
		this.tagName = "media-controls-group";
	}
	connectedCallback() {
		super.connectedCallback();
		if (this.hasAttribute("aria-label") || this.hasAttribute("aria-labelledby")) this.setAttribute("role", "group");
	}
};

//#endregion
//#region ../html/dist/default/ui/error-dialog/error-dialog-element.js
let idCounter$1 = 0;
function hasAuthoredContent$1(host) {
	return Array.from(host.childNodes).some((node) => !!node.textContent?.trim());
}
var ErrorDialogElement = class extends MediaElement {
	static {
		this.tagName = "media-error-dialog";
	}
	#core = new ErrorDialogCore();
	#provider = new i(this, { context: alertDialogContext });
	#titleId = `vjs-error-dialog-title-${idCounter$1++}`;
	#descriptionId = `vjs-error-dialog-desc-${idCounter$1++}`;
	#errorState = new PlayerController(this, playerContext, selectError);
	#i18n = new I18nController(this, i18nContext);
	#dialog = null;
	#snapshot = null;
	#lastError = null;
	#lastDescription = null;
	#seenCopyParts = /* @__PURE__ */ new WeakSet();
	#authoredCopyParts = /* @__PURE__ */ new WeakSet();
	constructor() {
		super();
		this.#core.setTitleId(this.#titleId);
		this.#core.setDescriptionId(this.#descriptionId);
	}
	connectedCallback() {
		super.connectedCallback();
		if (this.destroyed) return;
		this.#dialog = createAlertDialog({
			transition: createTransition(),
			onOpenChange: (nextOpen) => {
				if (!nextOpen) this.#errorState.value?.dismissError();
			}
		});
		this.#dialog.setElement(this);
		if (this.#snapshot) this.#snapshot.track(this.#dialog.input);
		else this.#snapshot = new SnapshotController(this, this.#dialog.input);
	}
	disconnectedCallback() {
		super.disconnectedCallback();
		this.#dialog?.destroy();
		this.#dialog = null;
	}
	willUpdate(_changed) {
		super.willUpdate(_changed);
		if (!this.#dialog) return;
		const errorState = this.#errorState.value;
		const hasError = Boolean(errorState?.error);
		const { active: isOpen } = this.#dialog.input.current;
		if (errorState?.error) this.#lastError = errorState.error;
		const errorForCopy = errorState?.error ?? (isOpen ? this.#lastError : null);
		this.#syncDialogCopy(errorForCopy);
		if (!hasError && !isOpen) {
			this.#lastError = null;
			this.#lastDescription = null;
		}
		if (hasError && !isOpen) this.#dialog.open();
		else if (!hasError && isOpen) this.#dialog.close();
	}
	update(_changed) {
		super.update(_changed);
		if (!this.#dialog) return;
		const input = this.#dialog.input.current;
		this.#core.setInput(input);
		const state = this.#core.getState();
		applyElementProps(this, this.#core.getAttrs(state));
		applyStateDataAttrs(this, state, AlertDialogDataAttrs);
		this.#provider.setValue({
			state,
			stateAttrMap: AlertDialogDataAttrs,
			close: () => this.#dialog?.close()
		});
	}
	#syncDialogCopy(error) {
		const t = this.#i18n.value;
		const title = this.querySelector("media-alert-dialog-title");
		if (title && !this.#hasAuthoredCopy(title)) title.textContent = translateText(getErrorDialogTitleText(), t);
		const desc = this.querySelector("media-alert-dialog-description");
		if (desc && !this.#hasAuthoredCopy(desc)) {
			const description = error ? resolveErrorDialogDescription(error) : null;
			if (description) this.#lastDescription = description;
			const copy = description ?? this.#lastDescription;
			desc.textContent = copy ? translateText(copy, t) : translateText(getErrorDialogUnexpectedText(), t);
		}
		const close = this.querySelector("media-alert-dialog-close");
		if (close && !this.#hasAuthoredCopy(close)) close.textContent = translateText(getErrorDialogDismissText(), t);
	}
	#hasAuthoredCopy(el) {
		if (!this.#seenCopyParts.has(el)) {
			this.#seenCopyParts.add(el);
			if (hasAuthoredContent$1(el)) this.#authoredCopyParts.add(el);
		}
		return this.#authoredCopyParts.has(el);
	}
};

//#endregion
//#region ../html/dist/default/ui/menu/menu-checkbox-item-element.js
var MenuCheckboxItemElement = class extends MediaElement {
	constructor(..._args) {
		super(..._args);
		this.checked = false;
		this.disabled = false;
		this.#ctx = new s$1(this, {
			context: menuContext,
			subscribe: true
		});
		this.#disconnect = null;
		this.#registered = false;
		this.#cleanupRegistration = null;
	}
	static {
		this.tagName = "media-menu-checkbox-item";
	}
	static {
		this.properties = {
			checked: { type: Boolean },
			disabled: { type: Boolean }
		};
	}
	#ctx;
	#disconnect;
	#registered;
	#cleanupRegistration;
	connectedCallback() {
		super.connectedCallback();
		this.#disconnect = new AbortController();
		this.#registered = false;
	}
	disconnectedCallback() {
		super.disconnectedCallback();
		this.#cleanupRegistration?.();
		this.#cleanupRegistration = null;
		this.#disconnect?.abort();
		this.#disconnect = null;
		this.#registered = false;
	}
	update(_changed) {
		super.update(_changed);
		const ctx = this.#ctx.value;
		if (!ctx || !this.#disconnect) return;
		if (!this.#registered) {
			this.#registered = true;
			this.#cleanupRegistration = ctx.menu.registerItem(this);
			applyElementProps(this, {
				onClick: () => {
					if (!this.#ctx.value || this.disabled) return;
					this.checked = !this.checked;
					this.dispatchEvent(new CustomEvent("checked-change", {
						detail: { checked: this.checked },
						bubbles: true
					}));
				},
				onPointerenter: () => {
					const currentCtx = this.#ctx.value;
					if (!this.disabled) currentCtx?.menu.highlight(this, { focus: false });
				}
			}, { signal: this.#disconnect.signal });
		}
		applyElementProps(this, {
			role: "menuitemcheckbox",
			"aria-checked": String(this.checked),
			"aria-disabled": this.disabled ? "true" : void 0
		});
	}
};

//#endregion
//#region ../html/dist/default/ui/menu/menu-element.js
const defaultTriggerMetadata = {
	hint: "",
	disabled: false
};
var MenuElement = class extends MediaElement {
	constructor(..._args) {
		super(..._args);
		this.open = MenuCore.defaultProps.open;
		this.defaultOpen = MenuCore.defaultProps.defaultOpen;
		this.side = MenuCore.defaultProps.side;
		this.align = MenuCore.defaultProps.align;
		this.closeOnEscape = MenuCore.defaultProps.closeOnEscape;
		this.closeOnOutsideClick = MenuCore.defaultProps.closeOnOutsideClick;
		this.boundary = "container";
		this.#core = new MenuCore();
		this.#provider = new i(this, { context: menuContext });
		this.#position = new PositionController(this);
		this.#controlsState = new PlayerController(this, playerContext, selectControls);
		this.#containerCtx = new s$1(this, {
			context: containerContext,
			subscribe: true
		});
		this.#popupGroupCtx = new s$1(this, { context: popupGroupContext });
		this.#parentCtx = new s$1(this, {
			context: menuContext,
			subscribe: true
		});
		this.#menu = null;
		this.#snapshot = null;
		this.#submenuActive = false;
		this.#disconnect = null;
		this.#triggerAbort = null;
		this.#cleanupSizeObserver = null;
		this.#currentTrigger = null;
		this.#metadataTrigger = null;
		this.#triggerMetadata = defaultTriggerMetadata;
		this.#releaseControlsLock = null;
		this.#registeredParentMenu = null;
		this.#cleanupParentRegistration = null;
		this.#handleContentKeyDown = (event) => {
			const isNavigationKey = isMenuNavigationKey(event);
			const defaultPreventedBeforeMenu = event.defaultPrevented;
			this.#menu?.contentProps.onKeyDown(event);
			if (!(this.#parentCtx.value ?? null)) {
				if (event.key === "Escape") return;
				if (isNavigationKey) event.stopPropagation();
				return;
			}
			if ((event.key === "ArrowLeft" || event.key === "Escape") && !defaultPreventedBeforeMenu) {
				event.preventDefault();
				this.#menu?.close("escape");
			}
			if (isNavigationKey) event.stopPropagation();
		};
		this.#handleContentFocusOut = (event) => {
			this.#menu?.contentProps.onFocusOut(event);
		};
		this.#setTriggerMetadata = (metadata) => {
			if (metadata.hint === this.#triggerMetadata.hint && metadata.disabled === this.#triggerMetadata.disabled && metadata.availability === this.#triggerMetadata.availability) return;
			this.#triggerMetadata = metadata;
			if (metadata.disabled && this.open && this.#parentCtx.value) this.close("imperative-action");
			this.requestUpdate();
		};
	}
	static {
		this.tagName = "media-menu";
	}
	static {
		this.properties = {
			open: { type: Boolean },
			defaultOpen: {
				type: Boolean,
				attribute: "default-open"
			},
			side: { type: String },
			align: { type: String },
			closeOnEscape: {
				type: Boolean,
				attribute: "close-on-escape"
			},
			closeOnOutsideClick: {
				type: Boolean,
				attribute: "close-on-outside-click"
			},
			boundary: { type: String }
		};
	}
	#core;
	#provider;
	#position;
	#controlsState;
	#containerCtx;
	#popupGroupCtx;
	#parentCtx;
	#menu;
	#snapshot;
	#submenuActive;
	#disconnect;
	#triggerAbort;
	#cleanupSizeObserver;
	#currentTrigger;
	#metadataTrigger;
	#triggerMetadata;
	#releaseControlsLock;
	#registeredParentMenu;
	#cleanupParentRegistration;
	connectedCallback() {
		super.connectedCallback();
		if (this.destroyed) return;
		this.setAttribute(POPUP_HOST_ATTR, "");
		this.#disconnect = new AbortController();
		this.#menu = createMenu({
			transition: createTransition(),
			onOpenChange: (nextOpen, details) => {
				if (this.dispatchEvent(new CustomEvent("open-change", {
					bubbles: true,
					cancelable: true,
					composed: true,
					detail: {
						open: nextOpen,
						...details
					}
				}))) this.open = nextOpen;
			},
			closeOnEscape: () => this.closeOnEscape,
			closeOnOutsideClick: () => this.closeOnOutsideClick,
			group: () => this.#parentCtx.value ? void 0 : this.#popupGroupCtx.value
		});
		this.#menu.setContentElement(this);
		applyElementProps(this, {
			onKeyDown: this.#handleContentKeyDown,
			onFocusOut: this.#handleContentFocusOut
		}, { signal: this.#disconnect.signal });
		if (this.#snapshot) this.#snapshot.track(this.#menu.input);
		else this.#snapshot = new SnapshotController(this, this.#menu.input);
	}
	disconnectedCallback() {
		this.#releaseControlsVisibilityLock();
		super.disconnectedCallback();
		this.#cleanupSizeObserver?.();
		this.#cleanupSizeObserver = null;
		this.#syncTriggerMetadata(null);
		this.#cleanupTrigger();
		this.#cleanupParentRegistration?.();
		this.#cleanupParentRegistration = null;
		this.#registeredParentMenu = null;
		this.#menu?.destroy();
		this.#menu = null;
		this.#disconnect?.abort();
		this.#disconnect = null;
	}
	close(reason = "imperative-action") {
		this.#menu?.close(reason);
	}
	openMenu(reason = "imperative-action") {
		this.#menu?.open(reason);
	}
	willUpdate(changed) {
		super.willUpdate(changed);
		if (!this.hasUpdated && this.defaultOpen && !this.open) this.open = true;
		const parentCtx = this.#parentCtx.value ?? null;
		const isSubmenu = parentCtx !== null;
		this.#syncParentRegistration(parentCtx);
		this.#core.setProps({
			open: this.open,
			defaultOpen: this.defaultOpen,
			side: this.side,
			align: this.align,
			closeOnEscape: this.closeOnEscape,
			closeOnOutsideClick: this.closeOnOutsideClick,
			isSubmenu
		});
		if (this.#menu && changed.has("open")) this.#menu.syncOpen(this.open);
	}
	update(_changed) {
		super.update(_changed);
		if (!this.#menu) return;
		const parentCtx = this.#parentCtx.value ?? null;
		const isSubmenu = parentCtx !== null;
		const input = this.#menu.input.current;
		this.#core.setInput(input);
		const state = this.#core.getState();
		if (!isSubmenu && state.open) this.#releaseControlsLock ??= this.#controlsState.value?.requestControlsLock() ?? null;
		else this.#releaseControlsVisibilityLock();
		if (isSubmenu && parentCtx) this.#updateAsSubmenu(state, parentCtx);
		else this.#updateAsRoot(state);
		this.#provider.setValue({
			menu: this.#menu,
			state,
			stateAttrMap: MenuDataAttrs,
			setTriggerMetadata: this.#setTriggerMetadata
		});
	}
	#releaseControlsVisibilityLock() {
		this.#releaseControlsLock?.();
		this.#releaseControlsLock = null;
	}
	#syncParentRegistration(parentCtx) {
		const parentMenu = parentCtx?.menu ?? null;
		if (parentMenu === this.#registeredParentMenu || !this.#menu) return;
		this.#cleanupParentRegistration?.();
		this.#registeredParentMenu = parentMenu;
		this.#cleanupParentRegistration = parentMenu?.registerSubmenu(this.#menu) ?? null;
	}
	#updateAsRoot(state) {
		if (!this.#menu) return;
		const triggerElement = this.#position.findTrigger();
		this.#syncTrigger(triggerElement);
		applyElementProps(this, { ...this.#core.getContentAttrs(state) });
		applyStateDataAttrs(this, state, MenuDataAttrs);
		if (state.open) tryShowPopover(this);
		else tryHidePopover(this);
		if (this.#currentTrigger) applyElementProps(this.#currentTrigger, this.#core.getTriggerAttrs(state, this.id));
		if (!state.open) {
			this.#cleanupSizeObserver?.();
			this.#cleanupSizeObserver = null;
			this.#position.cleanup();
			return;
		}
		this.#cleanupSizeObserver?.();
		const syncSize = () => syncMenuSizeChain(this);
		syncSize();
		this.#cleanupSizeObserver = observeMenuSize(this, syncSize);
		const positionOptions = getRootPositionOptions(state.side, state.align);
		if (!positionOptions || !this.#currentTrigger) return;
		this.#position.sync({
			anchorName: this.id,
			position: positionOptions,
			trigger: this.#currentTrigger,
			boundary: this.boundary,
			container: this.#containerCtx.value?.container ?? null,
			cssVars: MenuPositioningCSSVars,
			onSideChange: (side) => this.setAttribute(MenuDataAttrs.side, side)
		});
	}
	#updateAsSubmenu(state, parentCtx) {
		const isActive = state.open || state.status === "ending";
		const triggerElement = this.parentElement?.querySelector(`[data-has-submenu][commandfor="${this.id}"]`);
		this.#menu?.setTriggerElement(triggerElement ?? null);
		if (triggerElement) applyElementProps(triggerElement, this.#core.getTriggerAttrs(state, this.id));
		this.#syncTriggerMetadata(triggerElement ?? null);
		this.removeAttribute(MenuDataAttrs.side);
		this.removeAttribute(MenuDataAttrs.align);
		applyStateDataAttrs(this, state, MenuDataAttrs);
		applyElementProps(this, {
			hidden: !isActive,
			role: "menu",
			tabIndex: -1
		});
		if (isActive && !this.#submenuActive) this.#menu?.highlightFirstItem({ preventScroll: true });
		else if (!isActive && this.#submenuActive) triggerElement?.focus({ preventScroll: true });
		this.#submenuActive = isActive;
		this.#cleanupSizeObserver?.();
		const parentContentElement = parentCtx.menu.contentElement;
		const syncSize = () => syncMenuSizeChain(parentContentElement);
		syncSize();
		this.#cleanupSizeObserver = isActive && parentContentElement ? observeMenuSize(parentContentElement, syncSize) : null;
	}
	#handleContentKeyDown;
	#handleContentFocusOut;
	#setTriggerMetadata;
	#syncTriggerMetadata(trigger) {
		if (trigger !== this.#metadataTrigger) {
			this.#clearTriggerMetadata();
			this.#metadataTrigger = trigger;
		}
		if (!trigger) return;
		applyElementProps(trigger, {
			"aria-disabled": this.#triggerMetadata.disabled || isTriggerExplicitlyDisabled(trigger) ? "true" : void 0,
			"data-availability": this.#triggerMetadata.availability
		});
		const hint = trigger.querySelector("[data-part~=\"hint\"]");
		if (hint && hint.textContent !== this.#triggerMetadata.hint) hint.textContent = this.#triggerMetadata.hint;
	}
	#clearTriggerMetadata() {
		const trigger = this.#metadataTrigger;
		if (!trigger) return;
		applyElementProps(trigger, {
			"aria-disabled": isTriggerExplicitlyDisabled(trigger) ? "true" : void 0,
			"data-availability": void 0
		});
		const hint = trigger.querySelector("[data-part~=\"hint\"]");
		if (hint?.textContent) hint.textContent = "";
		this.#metadataTrigger = null;
	}
	#syncTrigger(triggerElement) {
		if (triggerElement === this.#currentTrigger) return;
		this.#position.cleanup();
		this.#cleanupTrigger();
		this.#currentTrigger = triggerElement;
		this.#menu?.setTriggerElement(triggerElement);
		if (triggerElement && this.#menu) {
			this.#triggerAbort = new AbortController();
			applyElementProps(triggerElement, this.#menu.triggerProps, { signal: this.#triggerAbort.signal });
		}
	}
	#cleanupTrigger() {
		if (this.#currentTrigger) applyElementProps(this.#currentTrigger, {
			"aria-expanded": void 0,
			"aria-haspopup": void 0,
			"aria-controls": void 0
		});
		this.#triggerAbort?.abort();
		this.#triggerAbort = null;
		this.#currentTrigger = null;
	}
};
function isTriggerExplicitlyDisabled(trigger) {
	return trigger.hasAttribute("disabled") || "disabled" in trigger && trigger.disabled === true;
}

//#endregion
//#region ../html/dist/default/ui/menu/menu-group-element.js
var MenuGroupElement = class extends MediaElement {
	static {
		this.tagName = "media-menu-group";
	}
	#group = new MenuGroupController(this);
	update(_changed) {
		super.update(_changed);
		this.#group.applyProps();
	}
};

//#endregion
//#region ../html/dist/default/ui/menu/menu-group-label-element.js
let idCounter = 0;
var MenuGroupLabelElement = class extends MediaElement {
	static {
		this.tagName = "media-menu-group-label";
	}
	#groupCtx = new s$1(this, {
		context: menuGroupContext,
		subscribe: true
	});
	#generatedId = `vjs-menu-group-label-${idCounter++}`;
	#cleanupRegistration = null;
	#registeredId = null;
	disconnectedCallback() {
		super.disconnectedCallback();
		this.#cleanupRegistration?.();
		this.#cleanupRegistration = null;
		this.#registeredId = null;
	}
	update(_changed) {
		super.update(_changed);
		if (!this.id) this.id = this.#generatedId;
		this.#registerLabel();
	}
	#registerLabel() {
		const groupCtx = this.#groupCtx.value;
		if (!groupCtx) {
			this.#cleanupRegistration?.();
			this.#cleanupRegistration = null;
			this.#registeredId = null;
			return;
		}
		if (this.#registeredId === this.id) return;
		this.#cleanupRegistration?.();
		this.#registeredId = this.id;
		this.#cleanupRegistration = groupCtx.registerLabel(this.id);
	}
};

//#endregion
//#region ../html/dist/default/ui/menu/menu-item-element.js
var MenuItemElement = class extends MediaElement {
	constructor(..._args) {
		super(..._args);
		this.disabled = false;
		this.commandfor = void 0;
		this.#ctx = new s$1(this, {
			context: menuContext,
			subscribe: true
		});
		this.#disconnect = null;
		this.#registeredMenu = null;
		this.#cleanupRegistration = null;
	}
	static {
		this.tagName = "media-menu-item";
	}
	static {
		this.properties = {
			disabled: { type: Boolean },
			commandfor: { type: String }
		};
	}
	#ctx;
	#disconnect;
	#registeredMenu;
	#cleanupRegistration;
	connectedCallback() {
		super.connectedCallback();
		this.#disconnect = new AbortController();
	}
	disconnectedCallback() {
		super.disconnectedCallback();
		this.#cleanupRegistration?.();
		this.#cleanupRegistration = null;
		this.#registeredMenu = null;
		this.#disconnect?.abort();
		this.#disconnect = null;
	}
	update(_changed) {
		super.update(_changed);
		const ctx = this.#ctx.value;
		if (!ctx || !this.#disconnect) return;
		if (this.#registeredMenu !== ctx.menu) {
			this.#cleanupRegistration?.();
			this.#registeredMenu = ctx.menu;
			this.#cleanupRegistration = ctx.menu.registerItem(this);
			applyElementProps(this, {
				onClick: (event) => {
					const currentCtx = this.#ctx.value;
					if (!currentCtx || this.#isDisabled()) return;
					const target = this.commandfor;
					if (target) this.#openSubmenu(target);
					else {
						const select = new CustomEvent("select", {
							bubbles: true,
							cancelable: true
						});
						if (!this.dispatchEvent(select)) {
							event.preventDefault();
							return;
						}
						completeMenuItemSelection(currentCtx.menu);
					}
					event.preventDefault();
				},
				onKeyDown: (event) => {
					if (!this.#ctx.value || this.#isDisabled() || event.key !== "ArrowRight") return;
					const target = this.commandfor;
					if (!target) return;
					this.#openSubmenu(target);
					event.preventDefault();
				},
				onPointerenter: () => {
					const currentCtx = this.#ctx.value;
					if (!this.#isDisabled()) currentCtx?.menu.highlight(this, { focus: false });
				}
			}, { signal: this.#disconnect.signal });
		}
		const hasSubmenu = Boolean(this.commandfor);
		applyElementProps(this, {
			role: "menuitem",
			"aria-disabled": this.#isDisabled() ? "true" : void 0,
			...hasSubmenu && {
				"aria-haspopup": "menu",
				"aria-expanded": "false",
				"data-has-submenu": ""
			}
		});
	}
	#openSubmenu(id) {
		this.getRootNode().querySelector(`#${CSS.escape(id)}`)?.openMenu?.("click");
	}
	#isDisabled() {
		return this.disabled || this.getAttribute("aria-disabled") === "true";
	}
};

//#endregion
//#region ../html/dist/default/ui/menu/menu-separator-element.js
var MenuSeparatorElement = class extends MediaElement {
	static {
		this.tagName = "media-menu-separator";
	}
	update(_changed) {
		super.update(_changed);
		applyElementProps(this, { role: "separator" });
	}
};

//#endregion
//#region ../html/dist/default/ui/input-indicator/input-indicator-element.js
var InputIndicatorElement = class extends MediaElement {
	constructor(..._args) {
		super(..._args);
		this.player = new PlayerController(this, playerContext);
		this.container = new s$1(this, {
			context: containerContext,
			callback: () => this.#reconnect(),
			subscribe: true
		});
		this.#disconnect = null;
		this.#inputActionUnsubscribe = null;
		this.#visibilityUnsubscribe = null;
		this.#visibilityHandle = null;
		this.#lastGeneration = 0;
		this.#snapshot = null;
	}
	get options() {
		return {};
	}
	#disconnect;
	#inputActionUnsubscribe;
	#visibilityUnsubscribe;
	#visibilityHandle;
	#lastGeneration;
	#snapshot;
	#getVisibilityHandle() {
		return this.#visibilityHandle ??= { close: () => this.core.close() };
	}
	#payloadSnapshot() {
		return this.#snapshot ?? this.core.state.current;
	}
	connectedCallback() {
		super.connectedCallback();
		if (this.destroyed) return;
		this.#snapshot = this.core.state.current;
		this.#disconnect = new AbortController();
		this.core.state.subscribe(() => this.requestUpdate(), { signal: this.#disconnect.signal });
		this.transition.state.subscribe(() => this.requestUpdate(), { signal: this.#disconnect.signal });
		this.hidden = true;
		this.#reconnect();
	}
	disconnectedCallback() {
		super.disconnectedCallback();
		this.#inputActionUnsubscribe?.();
		this.#visibilityUnsubscribe?.();
		this.#inputActionUnsubscribe = null;
		this.#visibilityUnsubscribe = null;
		this.#disconnect?.abort();
		this.#disconnect = null;
	}
	destroyCallback() {
		this.#inputActionUnsubscribe?.();
		this.#visibilityUnsubscribe?.();
		this.core.destroy();
		this.transition.destroy();
		this.liveIndicator.remove();
		super.destroyCallback();
	}
	willUpdate(changed) {
		super.willUpdate(changed);
		this.syncCoreProps();
	}
	update(changed) {
		super.update(changed);
		this.#syncTransition();
		const currentState = this.core.state.current;
		const transitionState = this.transition.state.current;
		if (!isIndicatorPresent(currentState, transitionState)) {
			this.liveIndicator.remove();
			return;
		}
		const state = getRenderedIndicatorState(currentState, this.#payloadSnapshot(), transitionState);
		this.liveIndicator.render(state);
	}
	#syncTransition() {
		const currentState = this.core.state.current;
		if (currentState.open) {
			this.#snapshot = currentState;
			if (this.#lastGeneration !== currentState.generation) {
				this.#lastGeneration = currentState.generation;
				const transitionState = this.transition.state.current;
				if (!transitionState.active || this.options.replayOnUpdate !== false) this.transition.open(this.liveIndicator.element);
				else if (transitionState.status === "ending") this.transition.cancel();
			}
			return;
		}
		const { active, status } = this.transition.state.current;
		if (active && status !== "ending") this.transition.close(this.liveIndicator.element);
	}
	#reconnect() {
		if (!this.container) return;
		this.#inputActionUnsubscribe?.();
		this.#visibilityUnsubscribe?.();
		this.#inputActionUnsubscribe = null;
		this.#visibilityUnsubscribe = null;
		const container = this.container.value?.container;
		if (!container) return;
		const visibility = getIndicatorVisibilityCoordinator(container);
		const visibilityHandle = this.#getVisibilityHandle();
		this.#visibilityUnsubscribe = visibility.register(visibilityHandle);
		this.#inputActionUnsubscribe = subscribeToInputActions(container, (event) => {
			if (this.core.processEvent(event, getMediaSnapshot(this.player.value))) visibility.show(visibilityHandle);
		});
	}
};

//#endregion
//#region ../html/dist/default/ui/input-indicator/live-indicator.js
var LiveIndicator = class {
	#host;
	#dataAttrs;
	#render;
	constructor(options) {
		this.#host = options.host;
		this.#dataAttrs = options.dataAttrs;
		this.#render = options.render;
	}
	get element() {
		return this.#host;
	}
	render(state) {
		this.#host.hidden = false;
		applyStateDataAttrs(this.#host, state, this.#dataAttrs);
		this.#render(this.#host, state);
		return this.#host;
	}
	remove() {
		this.#host.hidden = true;
		for (const key in this.#dataAttrs) {
			const name = this.#dataAttrs[key];
			if (name) this.#host.removeAttribute(name);
		}
	}
};

//#endregion
//#region ../html/dist/default/ui/seek-indicator/seek-indicator-element.js
var SeekIndicatorElement = class extends InputIndicatorElement {
	static {
		this.tagName = "media-seek-indicator";
	}
	static {
		this.properties = { closeDelay: {
			type: Number,
			attribute: "close-delay"
		} };
	}
	#core = new SeekIndicatorCore();
	#transition = createTransition();
	#liveIndicator = new LiveIndicator({
		host: this,
		dataAttrs: SeekIndicatorDataAttrs,
		render: renderSeekIndicator
	});
	get core() {
		return this.#core;
	}
	get transition() {
		return this.#transition;
	}
	get liveIndicator() {
		return this.#liveIndicator;
	}
	syncCoreProps() {
		this.#core.setProps({ closeDelay: this.closeDelay });
	}
};
function renderSeekIndicator(element, state) {
	const value = element.querySelector("media-seek-indicator-value");
	if (!value) return;
	value.textContent = getSeekIndicatorDisplayValue(state);
}

//#endregion
//#region ../html/dist/default/ui/seek-indicator/seek-indicator-value-element.js
var SeekIndicatorValueElement = class extends MediaElement {
	static {
		this.tagName = "media-seek-indicator-value";
	}
};

//#endregion
//#region ../html/dist/default/ui/slider/slider-buffer-element.js
var SliderBufferElement = class extends ContextPartElement {
	constructor(..._args) {
		super(..._args);
		this.consumer = new s$1(this, {
			context: sliderContext,
			subscribe: true
		});
	}
	static {
		this.tagName = "media-slider-buffer";
	}
};

//#endregion
//#region ../html/dist/default/ui/slider/slider-fill-element.js
var SliderFillElement = class extends ContextPartElement {
	constructor(..._args) {
		super(..._args);
		this.consumer = new s$1(this, {
			context: sliderContext,
			subscribe: true
		});
	}
	static {
		this.tagName = "media-slider-fill";
	}
};

//#endregion
//#region ../html/dist/default/ui/slider/slider-preview-element.js
var SliderPreviewElement = class extends MediaElement {
	constructor(..._args) {
		super(..._args);
		this.overflow = "clamp";
		this.#ctx = new s$1(this, {
			context: sliderContext,
			subscribe: true
		});
		this.#stopObservingResize = null;
		this.#width = 0;
	}
	static {
		this.tagName = "media-slider-preview";
	}
	static {
		this.properties = { overflow: { type: String } };
	}
	#ctx;
	#stopObservingResize;
	#width;
	connectedCallback() {
		super.connectedCallback();
		this.#stopObservingResize = observeResize(this, ([entry]) => {
			this.#width = entry.contentRect.width;
			this.#applyPosition();
		});
	}
	disconnectedCallback() {
		super.disconnectedCallback();
		this.#stopObservingResize?.();
		this.#stopObservingResize = null;
	}
	#applyPosition() {
		applyStyles(this, getSliderPreviewStyle(this.#width, this.overflow));
	}
	update(_changed) {
		super.update(_changed);
		const ctx = this.#ctx.value;
		if (ctx) applyStateDataAttrs(this, ctx.state, ctx.stateAttrMap);
		this.#applyPosition();
	}
};

//#endregion
//#region ../html/dist/default/ui/slider/slider-thumb-element.js
var SliderThumbElement = class extends MediaElement {
	static {
		this.tagName = "media-slider-thumb";
	}
	#ctx = new s$1(this, {
		context: sliderContext,
		subscribe: true
	});
	#disconnect = null;
	#thumbPropsApplied = false;
	connectedCallback() {
		super.connectedCallback();
		this.#disconnect = new AbortController();
		this.#thumbPropsApplied = false;
	}
	disconnectedCallback() {
		super.disconnectedCallback();
		this.#disconnect?.abort();
		this.#disconnect = null;
		this.#thumbPropsApplied = false;
	}
	update(_changed) {
		super.update(_changed);
		const ctx = this.#ctx.value;
		if (!ctx) return;
		if (!this.#thumbPropsApplied && this.#disconnect) {
			applyElementProps(this, ctx.thumbProps, { signal: this.#disconnect.signal });
			this.#thumbPropsApplied = true;
		}
		applyElementProps(this, ctx.thumbAttrs);
		applyStateDataAttrs(this, ctx.state, ctx.stateAttrMap);
	}
};

//#endregion
//#region ../html/dist/default/ui/thumbnail/thumbnail-element.js
const SHADOW_CSS = `\
:host {
  display: inline-block;
  overflow: hidden;
}
img {
  display: block;
}`;
var ThumbnailElement = class extends MediaElement {
	static {
		this.tagName = "media-thumbnail";
	}
	static {
		this.properties = {
			time: { type: Number },
			crossOrigin: {
				type: String,
				attribute: "crossorigin"
			},
			loading: { type: String },
			fetchPriority: {
				type: String,
				attribute: "fetchpriority"
			}
		};
	}
	#core;
	#img;
	#textTracks;
	#thumbnails;
	#externalThumbnails;
	#lastTextTrack;
	#api;
	constructor() {
		super();
		this.time = 0;
		this.#core = new ThumbnailCore();
		this.#img = document.createElement("img");
		this.#textTracks = new PlayerController(this, playerContext, selectTextTrack);
		this.#thumbnails = [];
		this.#api = null;
		const shadow = this.attachShadow({ mode: "open" });
		const style = document.createElement("style");
		style.textContent = SHADOW_CSS;
		shadow.appendChild(style);
		this.#img.alt = "";
		this.#img.setAttribute("part", "img");
		this.#img.setAttribute("aria-hidden", "true");
		this.#img.setAttribute("decoding", "async");
		shadow.appendChild(this.#img);
	}
	/**
	* Set thumbnail images directly, bypassing the automatic `<track>` detection.
	* When set, this takes priority over the text track path.
	*/
	get thumbnails() {
		return this.#externalThumbnails;
	}
	set thumbnails(value) {
		this.#externalThumbnails = value;
		this.requestUpdate();
	}
	connectedCallback() {
		super.connectedCallback();
		if (this.destroyed) return;
		this.#api = createThumbnail({
			getContainer: () => this,
			getImg: () => this.#img,
			onStateChange: () => this.requestUpdate()
		});
	}
	disconnectedCallback() {
		super.disconnectedCallback();
	}
	destroyCallback() {
		this.#api?.destroy();
		super.destroyCallback();
	}
	update(changed) {
		super.update(changed);
		if (this.#externalThumbnails) this.#thumbnails = this.#externalThumbnails;
		else {
			const textTrack = this.#textTracks.value;
			if (textTrack !== this.#lastTextTrack) {
				this.#lastTextTrack = textTrack;
				this.#thumbnails = textTrack && textTrack.thumbnailCues.length > 0 ? mapCuesToThumbnails(textTrack.thumbnailCues, textTrack.thumbnailTrackSrc ?? void 0) : [];
			}
		}
		const thumbnail = this.#core.findActiveThumbnail(this.#thumbnails, this.time);
		applyElementProps(this.#img, {
			crossorigin: this.crossOrigin || void 0,
			loading: this.loading,
			fetchpriority: this.fetchPriority
		});
		this.#api?.updateSrc(thumbnail?.url);
		if (!thumbnail) {
			this.#img.removeAttribute("src");
			this.#resetStyles();
			const state = this.#core.getState(false, false, void 0);
			applyElementProps(this, this.#core.getAttrs(state));
			applyStateDataAttrs(this, state, ThumbnailDataAttrs);
			return;
		}
		if (this.#img.getAttribute("src") !== thumbnail.url) this.#img.src = thumbnail.url;
		const api = this.#api;
		const state = this.#core.getState(api?.loading ?? false, api?.error ?? false, thumbnail);
		applyElementProps(this, this.#core.getAttrs(state));
		applyStateDataAttrs(this, state, ThumbnailDataAttrs);
		if (api?.naturalWidth && api.naturalHeight) {
			const constraints = api.readConstraints();
			const result = this.#core.resize(thumbnail, api.naturalWidth, api.naturalHeight, constraints);
			if (result) this.#applyResize(result);
		}
	}
	#applyResize(result) {
		this.style.width = `${result.containerWidth}px`;
		this.style.height = `${result.containerHeight}px`;
		const imgStyle = this.#img.style;
		imgStyle.width = `${result.imageWidth}px`;
		imgStyle.height = `${result.imageHeight}px`;
		imgStyle.maxWidth = "none";
		imgStyle.transform = result.offsetX || result.offsetY ? `translate(-${result.offsetX}px, -${result.offsetY}px)` : "";
	}
	#resetStyles() {
		this.style.width = "";
		this.style.height = "";
		const imgStyle = this.#img.style;
		imgStyle.width = "";
		imgStyle.height = "";
		imgStyle.maxWidth = "";
		imgStyle.transform = "";
	}
};

//#endregion
//#region ../html/dist/default/ui/slider/slider-thumbnail-element.js
var SliderThumbnailElement = class extends ThumbnailElement {
	static {
		this.tagName = "media-slider-thumbnail";
	}
	#ctx = new s$1(this, {
		context: sliderContext,
		subscribe: true
	});
	update(changed) {
		const ctx = this.#ctx.value;
		if (ctx) this.time = ctx.pointerValue;
		super.update(changed);
	}
};

//#endregion
//#region ../html/dist/default/ui/slider/slider-track-element.js
var SliderTrackElement = class extends ContextPartElement {
	constructor(..._args) {
		super(..._args);
		this.consumer = new s$1(this, {
			context: sliderContext,
			subscribe: true
		});
	}
	static {
		this.tagName = "media-slider-track";
	}
};

//#endregion
//#region ../html/dist/default/ui/slider/slider-value-element.js
var SliderValueElement = class extends MediaElement {
	constructor(..._args) {
		super(..._args);
		this.type = "current";
		this.#ctx = new s$1(this, {
			context: sliderContext,
			subscribe: true
		});
	}
	static {
		this.tagName = "media-slider-value";
	}
	static {
		this.properties = { type: { type: String } };
	}
	#ctx;
	connectedCallback() {
		super.connectedCallback();
		this.setAttribute("aria-live", "off");
	}
	update(_changed) {
		super.update(_changed);
		const ctx = this.#ctx.value;
		if (!ctx) return;
		const value = this.type === "pointer" ? ctx.pointerValue : ctx.state.value;
		this.textContent = ctx.formatValue ? ctx.formatValue(value, this.type) : String(Math.round(value));
		applyStateDataAttrs(this, ctx.state, ctx.stateAttrMap);
	}
};

//#endregion
//#region ../html/dist/default/ui/status-announcer/status-announcer-element.js
var StatusAnnouncerElement = class extends MediaElement {
	static {
		this.tagName = "media-status-announcer";
	}
	static {
		this.properties = { closeDelay: {
			type: Number,
			attribute: "close-delay"
		} };
	}
	#i18n = new I18nController(this, i18nContext);
	#core = new StatusAnnouncerCore();
	#storeUnsubscribe = null;
	#player = new s$1(this, {
		context: playerContext,
		callback: (store) => this.#reconnect(store),
		subscribe: true
	});
	#container = new s$1(this, {
		context: containerContext,
		subscribe: true
	});
	#disconnect = null;
	#liveText = null;
	connectedCallback() {
		super.connectedCallback();
		if (this.destroyed) return;
		this.setAttribute("role", "status");
		this.#ensureLiveText();
		this.#disconnect = new AbortController();
		this.#core.state.subscribe(() => this.requestUpdate(), { signal: this.#disconnect.signal });
		this.#reconnect();
	}
	disconnectedCallback() {
		super.disconnectedCallback();
		this.#storeUnsubscribe?.();
		this.#storeUnsubscribe = null;
		this.#disconnect?.abort();
		this.#disconnect = null;
	}
	destroyCallback() {
		this.#storeUnsubscribe?.();
		this.#core.destroy();
		super.destroyCallback();
	}
	willUpdate(changed) {
		super.willUpdate(changed);
		this.#core.setProps({
			closeDelay: this.closeDelay,
			labels: createStatusAnnouncerLabels(this.#i18n.value, this.#i18n.locale),
			shouldAnnounce: () => shouldAnnounceStatusChange(this.#container.value?.container)
		});
	}
	update(changed) {
		super.update(changed);
		const label = this.#core.state.current.label;
		const liveText = this.#ensureLiveText();
		if (label === null) liveText.replaceChildren();
		else liveText.replaceChildren(document.createTextNode(label));
	}
	#reconnect(store = this.#player.value) {
		this.#storeUnsubscribe?.();
		this.#storeUnsubscribe = null;
		if (!store) {
			this.#core.resetSnapshot();
			return;
		}
		this.#storeUnsubscribe = subscribeToStatusAnnouncer(store, this.#core);
	}
	#ensureLiveText() {
		if (this.#liveText?.isConnected) return this.#liveText;
		const existing = this.querySelector("[data-status-announcer-content]");
		this.#liveText = existing ?? document.createElement("span");
		this.#liveText.setAttribute("data-status-announcer-content", "");
		if (!existing) this.append(this.#liveText);
		return this.#liveText;
	}
};

//#endregion
//#region ../html/dist/default/ui/status-indicator/status-indicator-element.js
var StatusIndicatorElement = class extends InputIndicatorElement {
	static {
		this.tagName = "media-status-indicator";
	}
	static {
		this.properties = {
			actions: { type: String },
			closeDelay: {
				type: Number,
				attribute: "close-delay"
			}
		};
	}
	#i18n = new I18nController(this, i18nContext);
	#core = new StatusIndicatorCore();
	#transition = createTransition();
	#liveIndicator = new LiveIndicator({
		host: this,
		dataAttrs: StatusIndicatorDataAttrs,
		render: renderStatusIndicator
	});
	get core() {
		return this.#core;
	}
	get transition() {
		return this.#transition;
	}
	get liveIndicator() {
		return this.#liveIndicator;
	}
	syncCoreProps() {
		this.#core.setProps({
			actions: parseActions(this.actions),
			closeDelay: this.closeDelay,
			labels: createInputIndicatorLabels(this.#i18n.value)
		});
	}
};
function parseActions(actions) {
	return actions?.split(/[\s,]+/).filter(Boolean);
}
function renderStatusIndicator(element, state) {
	const value = element.querySelector("media-status-indicator-value");
	if (!value) return;
	value.textContent = getStatusIndicatorDisplayValue(state);
}

//#endregion
//#region ../html/dist/default/ui/status-indicator/status-indicator-value-element.js
var StatusIndicatorValueElement = class extends MediaElement {
	static {
		this.tagName = "media-status-indicator-value";
	}
};

//#endregion
//#region ../html/dist/default/ui/time/time-element.js
var TimeElement = class extends MediaElement {
	constructor(..._args) {
		super(..._args);
		this.type = TimeCore.defaultProps.type;
		this.negativeSign = TimeCore.defaultProps.negativeSign;
		this.label = "";
		this.toggle = TimeCore.defaultProps.toggle;
		this.#core = new TimeCore();
		this.#state = new PlayerController(this, playerContext, selectTime);
		this.#i18n = new I18nController(this, i18nContext);
		this.#signSpan = document.createElement("span");
		this.#textNode = document.createTextNode("");
		this.#disconnect = null;
		this.#listening = false;
		this.#activeType = TimeCore.defaultProps.type;
		this.#handleClick = (event) => {
			if (event.defaultPrevented || !this.toggle || !this.#state.value) return;
			this.#toggleType();
		};
		this.#handleKeyDown = (event) => {
			if (event.defaultPrevented || !isInteractiveActivation(event)) return;
			if (!this.toggle || !this.#state.value) return;
			event.preventDefault();
			if (event.repeat) return;
			this.#toggleType();
		};
	}
	static {
		this.tagName = "media-time";
	}
	static {
		this.properties = {
			type: { type: String },
			negativeSign: {
				type: String,
				attribute: "negative-sign"
			},
			label: { type: String },
			toggle: { type: Boolean }
		};
	}
	#core;
	#state;
	#i18n;
	#signSpan;
	#textNode;
	#disconnect;
	#listening;
	#activeType;
	connectedCallback() {
		super.connectedCallback();
		this.#disconnect = new AbortController();
		this.#syncListeners();
		if (!this.#signSpan.parentNode) {
			this.#signSpan.setAttribute("aria-hidden", "true");
			this.#signSpan.hidden = true;
			this.appendChild(this.#signSpan);
			this.appendChild(this.#textNode);
		}
	}
	disconnectedCallback() {
		super.disconnectedCallback();
		this.#disconnect?.abort();
		this.#disconnect = null;
		this.#listening = false;
	}
	willUpdate(changed) {
		super.willUpdate(changed);
		if (changed.has("type") || changed.has("toggle")) this.#activeType = this.type;
	}
	update(changed) {
		super.update(changed);
		if (changed.has("toggle")) this.#syncListeners();
		const media = this.#state.value;
		if (!media) {
			this.#clearAttrs();
			return;
		}
		this.#core.setProps({
			type: this.toggle ? this.#activeType : this.type,
			negativeSign: this.negativeSign,
			label: this.label,
			toggle: this.toggle
		});
		this.#core.setMedia(media);
		this.#core.setFormatLocale(this.#i18n.locale);
		const state = this.#core.getState();
		this.#signSpan.hidden = !state.negative;
		this.#signSpan.textContent = state.negative ? this.negativeSign : "";
		this.#textNode.textContent = state.text;
		const attrs = this.#core.getAttrs(state, this.type);
		const label = translateText(attrs["aria-label"], this.#i18n.value, this.#getLabelParams(state));
		const description = attrs["aria-description"] ? translateText(attrs["aria-description"], this.#i18n.value) : void 0;
		applyElementProps(this, {
			"aria-label": label,
			"aria-description": description,
			role: this.toggle ? attrs.role : "time",
			tabIndex: attrs.tabIndex,
			datetime: this.toggle ? void 0 : state.datetime
		});
		applyStateDataAttrs(this, state, TimeDataAttrs);
	}
	#getLabelParams(state) {
		if (!this.#core.getLabelParams(state)) return void 0;
		const duration = formatTimeAsPhrase(Math.abs(state.seconds), { locale: this.#i18n.locale });
		const text = {
			current: elapsedSuffixText,
			duration: durationSuffixText,
			remaining: remainingSuffixText
		}[state.type];
		return { duration: translateText(text, this.#i18n.value, { duration }) };
	}
	#handleClick;
	#handleKeyDown;
	#toggleType() {
		if (this.type === "current") this.#activeType = this.#activeType === "remaining" ? "current" : "remaining";
		else this.#activeType = this.#activeType === "duration" ? "remaining" : "duration";
		this.requestUpdate();
	}
	#syncListeners() {
		if (!this.toggle || !this.#disconnect || this.#listening) return;
		this.#listening = true;
		applyElementProps(this, {
			onClick: this.#handleClick,
			onKeyDown: this.#handleKeyDown
		}, { signal: this.#disconnect.signal });
	}
	#clearAttrs() {
		applyElementProps(this, {
			"aria-label": void 0,
			"aria-description": void 0,
			role: void 0,
			tabIndex: void 0,
			datetime: void 0,
			"data-type": void 0
		});
	}
};

//#endregion
//#region ../html/dist/default/ui/time/time-group-element.js
var TimeGroupElement = class extends MediaElement {
	static {
		this.tagName = "media-time-group";
	}
};

//#endregion
//#region ../html/dist/default/ui/time/time-separator-element.js
var TimeSeparatorElement = class extends MediaElement {
	static {
		this.tagName = "media-time-separator";
	}
	connectedCallback() {
		super.connectedCallback();
		this.setAttribute("aria-hidden", "true");
		if (!this.textContent?.trim()) this.textContent = "/";
	}
};

//#endregion
//#region ../html/dist/default/ui/time-slider/time-slider-element.js
var TimeSliderElement = class extends MediaElement {
	constructor(..._args) {
		super(..._args);
		this.label = "";
		this.changeThrottle = TimeSliderCore.defaultProps.changeThrottle;
		this.step = TimeSliderCore.defaultProps.step;
		this.largeStep = TimeSliderCore.defaultProps.largeStep;
		this.orientation = TimeSliderCore.defaultProps.orientation;
		this.disabled = TimeSliderCore.defaultProps.disabled;
		this.thumbAlignment = TimeSliderCore.defaultProps.thumbAlignment;
		this.pauseOnDrag = TimeSliderCore.defaultProps.pauseOnDrag;
		this.#core = new TimeSliderCore();
		this.#controlsState = new PlayerController(this, playerContext, selectControls);
		this.#provider = new i(this, { context: sliderContext });
		this.#timeState = new PlayerController(this, playerContext, selectTime);
		this.#bufferState = new PlayerController(this, playerContext, selectBuffer);
		this.#playbackState = new PlayerController(this, playerContext, selectPlayback);
		this.#i18n = new I18nController(this, i18nContext);
		this.#slider = null;
		this.#disconnect = null;
		this.#releaseControlsLock = null;
	}
	static {
		this.tagName = "media-time-slider";
	}
	static {
		this.properties = {
			label: { type: String },
			changeThrottle: {
				type: Number,
				attribute: "change-throttle"
			},
			step: { type: Number },
			largeStep: {
				type: Number,
				attribute: "large-step"
			},
			orientation: { type: String },
			disabled: { type: Boolean },
			thumbAlignment: {
				type: String,
				attribute: "thumb-alignment"
			},
			pauseOnDrag: {
				type: Boolean,
				attribute: "pause-on-drag"
			}
		};
	}
	#core;
	#controlsState;
	#provider;
	#timeState;
	#bufferState;
	#playbackState;
	#i18n;
	#slider;
	#disconnect;
	#releaseControlsLock;
	connectedCallback() {
		super.connectedCallback();
		if (this.destroyed) return;
		this.#disconnect = new AbortController();
		const signal = this.#disconnect.signal;
		this.#slider = createSlider({
			getElement: () => this,
			getThumbElement: () => this.querySelector("media-slider-thumb"),
			getOrientation: () => this.orientation,
			isRTL: () => isRTL(this),
			isDisabled: () => this.disabled || !this.#timeState.value,
			getPercent: () => {
				const media = this.#timeState.value;
				if (!media) return 0;
				return this.#core.percentFromValue(media.currentTime);
			},
			getStepPercent: () => this.#core.getStepPercent(),
			getLargeStepPercent: () => this.#core.getLargeStepPercent(),
			onValueCommit: (percent) => {
				const media = this.#timeState.value;
				if (media) media.seek(this.#core.rawValueFromPercent(percent));
			},
			changeThrottle: this.changeThrottle,
			onDragStart: () => {
				this.#releaseControlsLock ??= this.#controlsState.value?.requestControlsLock() ?? null;
				this.#core.startDrag(this.#playbackState.value);
				this.dispatchEvent(new CustomEvent("drag-start", { bubbles: true }));
			},
			onDragEnd: () => {
				this.#releaseControlsVisibilityLock();
				this.#core.endDrag(this.#playbackState.value);
				this.dispatchEvent(new CustomEvent("drag-end", { bubbles: true }));
			},
			adjustPercent: (raw, thumbSize, trackSize) => this.#core.adjustPercentForAlignment(raw, thumbSize, trackSize),
			onResize: () => this.requestUpdate()
		});
		applyElementProps(this, this.#slider.rootProps, { signal });
		applyStyles(this, this.#slider.rootStyle);
		this.#slider.input.subscribe(() => this.requestUpdate(), { signal });
	}
	disconnectedCallback() {
		this.#releaseControlsVisibilityLock();
		this.#resumeIfDragPaused();
		super.disconnectedCallback();
		this.#disconnect?.abort();
		this.#disconnect = null;
	}
	destroyCallback() {
		this.#releaseControlsVisibilityLock();
		this.#resumeIfDragPaused();
		this.#slider?.destroy();
		super.destroyCallback();
	}
	#resumeIfDragPaused() {
		this.#core.endDrag(this.#playbackState.value);
	}
	#releaseControlsVisibilityLock() {
		this.#releaseControlsLock?.();
		this.#releaseControlsLock = null;
	}
	willUpdate(_changed) {
		super.willUpdate(_changed);
		this.#core.setProps({
			label: this.label,
			changeThrottle: this.changeThrottle,
			step: this.step,
			largeStep: this.largeStep,
			orientation: this.orientation,
			disabled: this.disabled,
			thumbAlignment: this.thumbAlignment,
			pauseOnDrag: this.pauseOnDrag
		});
		this.#core.setFormatLocale(this.#i18n.locale);
	}
	update(_changed) {
		super.update(_changed);
		if (!this.#slider) return;
		const time = this.#timeState.value;
		const buffer = this.#bufferState.value;
		if (!time) return;
		this.#core.setInput(this.#slider.input.current);
		const media = {
			...time,
			...buffer ?? {
				buffered: [],
				seekable: []
			}
		};
		this.#core.setMedia(media);
		const state = this.#core.getState();
		const cssVars = getTimeSliderCSSVars(this.#slider.adjustForAlignment(state));
		const thumbAttrs = this.#core.getAttrs(state);
		applyStyles(this, cssVars);
		applyStateDataAttrs(this, state, TimeSliderDataAttrs);
		this.#provider.setValue({
			state,
			stateAttrMap: TimeSliderDataAttrs,
			pointerValue: this.#core.rawValueFromPercent(state.pointerPercent),
			thumbAttrs: {
				...thumbAttrs,
				"aria-label": translateText(thumbAttrs["aria-label"], this.#i18n.value),
				"aria-valuetext": translateText(thumbAttrs["aria-valuetext"], this.#i18n.value, this.#core.getValueTextParams(state))
			},
			thumbProps: this.#slider.thumbProps,
			formatValue: (value) => formatTime$1(value, state.duration, { locale: this.#i18n.locale })
		});
	}
};

//#endregion
//#region ../html/dist/default/ui/tooltip/tooltip-label-element.js
function hasAuthoredContent(host) {
	return Array.from(host.childNodes).some((node) => !!node.textContent?.trim());
}
/** Label region inside `media-tooltip`; parent syncs text from the trigger when linked to a media button. */
var TooltipLabelElement = class TooltipLabelElement extends MediaElement {
	static {
		this.tagName = "media-tooltip-label";
	}
	#hasAuthoredContent = false;
	static findIn(host) {
		return host.querySelector(TooltipLabelElement.tagName);
	}
	static create() {
		return document.createElement(TooltipLabelElement.tagName);
	}
	connectedCallback() {
		this.#hasAuthoredContent ||= hasAuthoredContent(this);
		super.connectedCallback();
	}
	setSyncedText(text) {
		if (this.#hasAuthoredContent) return;
		this.textContent = text;
	}
};

//#endregion
//#region ../html/dist/default/ui/tooltip/tooltip-shortcut-element.js
/** Shortcut hint inside `media-tooltip`. CSS skins: `class="media-tooltip__kbd"`; Tailwind skins: `class` from `popup.tooltipShortcut`. */
var TooltipShortcutElement = class TooltipShortcutElement extends MediaElement {
	static {
		this.tagName = "media-tooltip-shortcut";
	}
	static findIn(host) {
		return host.querySelector(TooltipShortcutElement.tagName);
	}
	static create() {
		return document.createElement(TooltipShortcutElement.tagName);
	}
	setSyncedShortcut(shortcut) {
		if (shortcut) {
			this.textContent = shortcut;
			this.hidden = false;
		} else {
			this.textContent = "";
			this.hidden = true;
		}
	}
};

//#endregion
//#region ../html/dist/default/ui/tooltip/context.js
const tooltipGroupContext = n(Symbol("@videojs/tooltip-group"));

//#endregion
//#region ../html/dist/default/ui/tooltip/tooltip-element.js
function isLabelTrigger(el) {
	return "$state" in el;
}
var TooltipElement = class extends MediaElement {
	constructor(..._args) {
		super(..._args);
		this.open = TooltipCore.defaultProps.open;
		this.defaultOpen = TooltipCore.defaultProps.defaultOpen;
		this.side = TooltipCore.defaultProps.side;
		this.align = TooltipCore.defaultProps.align;
		this.delay = TooltipCore.defaultProps.delay;
		this.closeDelay = TooltipCore.defaultProps.closeDelay;
		this.disableHoverablePopup = TooltipCore.defaultProps.disableHoverablePopup;
		this.disabled = TooltipCore.defaultProps.disabled;
		this.boundary = "container";
		this.trigger = "";
		this.#core = new TooltipCore();
		this.#i18n = new I18nController(this, i18nContext);
		this.#groupConsumer = new s$1(this, { context: tooltipGroupContext });
		this.#containerCtx = new s$1(this, {
			context: containerContext,
			subscribe: true
		});
		this.#popupGroupCtx = new s$1(this, { context: popupGroupContext });
		this.#position = new PositionController(this);
		this.#tooltip = null;
		this.#snapshot = null;
		this.#disconnect = null;
		this.#triggerAbort = null;
		this.#currentTrigger = null;
	}
	static {
		this.tagName = "media-tooltip";
	}
	static {
		this.properties = {
			open: { type: Boolean },
			defaultOpen: {
				type: Boolean,
				attribute: "default-open"
			},
			side: { type: String },
			align: { type: String },
			delay: { type: Number },
			closeDelay: {
				type: Number,
				attribute: "close-delay"
			},
			disableHoverablePopup: {
				type: Boolean,
				attribute: "disable-hoverable-popup"
			},
			disabled: { type: Boolean },
			boundary: { type: String },
			trigger: { type: String }
		};
	}
	#core;
	#i18n;
	#groupConsumer;
	#containerCtx;
	#popupGroupCtx;
	#position;
	#tooltip;
	#snapshot;
	#disconnect;
	#triggerAbort;
	#currentTrigger;
	connectedCallback() {
		super.connectedCallback();
		if (this.destroyed) return;
		this.setAttribute(POPUP_HOST_ATTR, "");
		this.#disconnect = new AbortController();
		this.#tooltip = createTooltip({
			transition: createTransition(),
			onOpenChange: (nextOpen, details) => {
				this.open = nextOpen;
				this.dispatchEvent(new CustomEvent("open-change", { detail: {
					open: nextOpen,
					...details
				} }));
			},
			delay: () => this.delay,
			closeDelay: () => this.closeDelay,
			disableHoverablePopup: () => this.disableHoverablePopup,
			disabled: () => this.disabled,
			group: () => this.#groupConsumer.value,
			popupGroup: () => this.#popupGroupCtx.value
		});
		this.#tooltip.setPopupElement(this);
		applyElementProps(this, this.#tooltip.popupProps, { signal: this.#disconnect.signal });
		if (this.#snapshot) this.#snapshot.track(this.#tooltip.input);
		else this.#snapshot = new SnapshotController(this, this.#tooltip.input);
	}
	firstUpdated(changed) {
		super.firstUpdated(changed);
		if (this.defaultOpen && !this.open) this.#tooltip?.open();
	}
	disconnectedCallback() {
		super.disconnectedCallback();
		this.#cleanupTrigger();
		this.#tooltip?.destroy();
		this.#tooltip = null;
		this.#disconnect?.abort();
		this.#disconnect = null;
	}
	close(reason = "imperative-action") {
		this.#tooltip?.close(reason);
	}
	willUpdate(changed) {
		super.willUpdate(changed);
		this.#core.setProps(this);
		if (this.#tooltip && changed.has("open")) {
			const { active: interactionOpen } = this.#tooltip.input.current;
			if (this.open !== interactionOpen) if (this.open) this.#tooltip.open();
			else this.#tooltip.close();
		}
	}
	update(_changed) {
		super.update(_changed);
		if (!this.#tooltip) return;
		const triggerEl = this.#position.findTrigger(this.trigger);
		this.#syncTrigger(triggerEl);
		if (this.#currentTrigger && isLabelTrigger(this.#currentTrigger)) this.#syncContent(this.#currentTrigger);
		const input = this.#tooltip.input.current;
		this.#core.setInput(input);
		const state = this.#core.getState();
		applyElementProps(this, this.#core.getPopupAttrs(state));
		applyStateDataAttrs(this, state, TooltipDataAttrs);
		if (state.open) tryShowPopover(this);
		else tryHidePopover(this);
		if (!state.open) {
			this.#position.cleanup();
			return;
		}
		this.#position.sync({
			anchorName: this.id,
			position: {
				side: state.side,
				align: state.align
			},
			trigger: this.#currentTrigger,
			boundary: this.boundary,
			container: this.#containerCtx.value?.container ?? null,
			cssVars: TooltipCSSVars,
			onSideChange: (side) => this.setAttribute(TooltipDataAttrs.side, side)
		});
	}
	#syncTrigger(triggerEl) {
		if (triggerEl === this.#currentTrigger) return;
		this.#position.cleanup();
		this.#cleanupTrigger();
		this.#currentTrigger = triggerEl;
		this.#tooltip?.setTriggerElement(triggerEl);
		if (triggerEl && this.#tooltip) {
			this.#triggerAbort = new AbortController();
			applyElementProps(triggerEl, this.#tooltip.triggerProps, { signal: this.#triggerAbort.signal });
			if (isLabelTrigger(triggerEl)) {
				this.#syncContent(triggerEl);
				triggerEl.$state.subscribe(() => this.#syncContent(triggerEl), { signal: this.#triggerAbort.signal });
				listen(triggerEl, HOTKEY_SHORTCUT_CHANGE_EVENT, () => this.#syncContent(triggerEl), { signal: this.#triggerAbort.signal });
			}
		}
	}
	#syncContent(triggerEl) {
		const label = triggerEl.getLabel();
		let resolved = isFunction(triggerEl.getResolvedLabel) ? triggerEl.getResolvedLabel() : void 0;
		if (resolved === void 0 && label) resolved = translateText(label, this.#i18n.value);
		const shortcut = triggerEl.getShortcut?.();
		let labelEl = TooltipLabelElement.findIn(this);
		let shortcutEl = TooltipShortcutElement.findIn(this);
		if (!labelEl && !shortcutEl) {
			if (this.#hostHasAuthoredTooltipContent()) return;
			labelEl = TooltipLabelElement.create();
			shortcutEl = TooltipShortcutElement.create();
			this.replaceChildren(labelEl, shortcutEl);
		}
		labelEl?.setSyncedText(resolved ?? "");
		shortcutEl?.setSyncedShortcut(shortcut);
	}
	#hostHasAuthoredTooltipContent() {
		return Array.from(this.childNodes).some((node) => !!node.textContent?.trim());
	}
	#cleanupTrigger() {
		this.#triggerAbort?.abort();
		this.#triggerAbort = null;
		this.#currentTrigger = null;
	}
};

//#endregion
//#region ../html/dist/default/ui/tooltip/tooltip-group-element.js
var TooltipGroupElement = class extends MediaElement {
	constructor(..._args) {
		super(..._args);
		this.delay = TooltipGroupCore.defaultProps.delay;
		this.closeDelay = TooltipGroupCore.defaultProps.closeDelay;
		this.timeout = TooltipGroupCore.defaultProps.timeout;
		this.#core = new TooltipGroupCore();
		this.#provider = new i(this, {
			context: tooltipGroupContext,
			initialValue: this.#core
		});
	}
	static {
		this.tagName = "media-tooltip-group";
	}
	static {
		this.properties = {
			delay: { type: Number },
			closeDelay: {
				type: Number,
				attribute: "close-delay"
			},
			timeout: { type: Number }
		};
	}
	#core;
	#provider;
	update(_changed) {
		super.update(_changed);
		this.#core.setProps(this);
		this.#provider.setValue(this.#core);
	}
};

//#endregion
//#region ../html/dist/default/ui/volume-indicator/volume-indicator-element.js
var VolumeIndicatorElement = class extends InputIndicatorElement {
	static {
		this.tagName = "media-volume-indicator";
	}
	static {
		this.properties = { closeDelay: {
			type: Number,
			attribute: "close-delay"
		} };
	}
	#i18n = new I18nController(this, i18nContext);
	#core = new VolumeIndicatorCore();
	#transition = createTransition();
	#liveIndicator = new LiveIndicator({
		host: this,
		dataAttrs: VolumeIndicatorDataAttrs,
		render: renderVolumeIndicator
	});
	#options = { replayOnUpdate: false };
	get core() {
		return this.#core;
	}
	get transition() {
		return this.#transition;
	}
	get liveIndicator() {
		return this.#liveIndicator;
	}
	get options() {
		return this.#options;
	}
	syncCoreProps() {
		this.#core.setProps({
			closeDelay: this.closeDelay,
			labels: createInputIndicatorLabels(this.#i18n.value)
		});
	}
};
function renderVolumeIndicator(element, state) {
	const fill = element.querySelector("media-volume-indicator-fill");
	const value = element.querySelector("media-volume-indicator-value");
	if (state.fill) fill?.style.setProperty(VolumeIndicatorCSSVars.fill, state.fill);
	else fill?.style.removeProperty(VolumeIndicatorCSSVars.fill);
	if (value) value.textContent = getVolumeIndicatorDisplayValue(state);
}

//#endregion
//#region ../html/dist/default/ui/volume-indicator/volume-indicator-fill-element.js
var VolumeIndicatorFillElement = class extends MediaElement {
	static {
		this.tagName = "media-volume-indicator-fill";
	}
};

//#endregion
//#region ../html/dist/default/ui/volume-indicator/volume-indicator-value-element.js
var VolumeIndicatorValueElement = class extends MediaElement {
	static {
		this.tagName = "media-volume-indicator-value";
	}
};

//#endregion
//#region ../html/dist/default/ui/volume-slider/volume-slider-element.js
var VolumeSliderElement = class extends MediaElement {
	constructor(..._args) {
		super(..._args);
		this.label = "";
		this.step = VolumeSliderCore.defaultProps.step;
		this.largeStep = VolumeSliderCore.defaultProps.largeStep;
		this.wheelStep = VolumeSliderCore.defaultProps.wheelStep;
		this.orientation = VolumeSliderCore.defaultProps.orientation;
		this.disabled = VolumeSliderCore.defaultProps.disabled;
		this.thumbAlignment = VolumeSliderCore.defaultProps.thumbAlignment;
		this.#core = new VolumeSliderCore();
		this.#controlsState = new PlayerController(this, playerContext, selectControls);
		this.#provider = new i(this, { context: sliderContext });
		this.#volumeState = new PlayerController(this, playerContext, selectVolume);
		this.#i18n = new I18nController(this, i18nContext);
		this.#slider = null;
		this.#disconnect = null;
		this.#releaseControlsLock = null;
	}
	static {
		this.tagName = "media-volume-slider";
	}
	static {
		this.properties = {
			label: { type: String },
			step: { type: Number },
			largeStep: {
				type: Number,
				attribute: "large-step"
			},
			wheelStep: {
				type: Number,
				attribute: "wheel-step"
			},
			orientation: { type: String },
			disabled: { type: Boolean },
			thumbAlignment: {
				type: String,
				attribute: "thumb-alignment"
			}
		};
	}
	#core;
	#controlsState;
	#provider;
	#volumeState;
	#i18n;
	#slider;
	#disconnect;
	#releaseControlsLock;
	connectedCallback() {
		super.connectedCallback();
		if (this.destroyed) return;
		this.#disconnect = new AbortController();
		const signal = this.#disconnect.signal;
		const isDisabled = () => {
			const volume = this.#volumeState.value;
			return this.disabled || !volume || volume.volumeAvailability !== "available";
		};
		const getPercent = () => (this.#volumeState.value?.volume ?? 0) * 100;
		const getStepPercent = () => this.#core.getStepPercent();
		const setVolume = (percent) => this.#setVolume(percent);
		this.#slider = createSlider({
			getElement: () => this,
			getThumbElement: () => this.querySelector("media-slider-thumb"),
			getOrientation: () => this.orientation,
			isRTL: () => isRTL(this),
			isDisabled,
			getPercent,
			getStepPercent,
			getLargeStepPercent: () => this.#core.getLargeStepPercent(),
			onValueChange: setVolume,
			onValueCommit: setVolume,
			onDragStart: () => {
				this.#releaseControlsLock ??= this.#controlsState.value?.requestControlsLock() ?? null;
				this.dispatchEvent(new CustomEvent("drag-start", { bubbles: true }));
			},
			onDragEnd: () => {
				this.#releaseControlsVisibilityLock();
				this.dispatchEvent(new CustomEvent("drag-end", { bubbles: true }));
			},
			adjustPercent: (raw, thumbSize, trackSize) => this.#core.adjustPercentForAlignment(raw, thumbSize, trackSize),
			onResize: () => this.requestUpdate()
		});
		const wheelProps = createWheelStep({
			isDisabled,
			getPercent,
			getStepPercent: () => this.#core.getWheelStepPercent(),
			onValueChange: setVolume
		});
		applyElementProps(this, this.#slider.rootProps, { signal });
		applyElementProps(this, wheelProps, { signal });
		applyStyles(this, this.#slider.rootStyle);
		this.#slider.input.subscribe(() => this.requestUpdate(), { signal });
	}
	disconnectedCallback() {
		this.#releaseControlsVisibilityLock();
		super.disconnectedCallback();
		this.#disconnect?.abort();
		this.#disconnect = null;
	}
	destroyCallback() {
		this.#releaseControlsVisibilityLock();
		this.#slider?.destroy();
		super.destroyCallback();
	}
	#releaseControlsVisibilityLock() {
		this.#releaseControlsLock?.();
		this.#releaseControlsLock = null;
	}
	willUpdate(_changed) {
		super.willUpdate(_changed);
		this.#core.setProps(this);
		this.#core.setFormatLocale(this.#i18n.locale);
	}
	update(_changed) {
		super.update(_changed);
		if (!this.#slider) return;
		const media = this.#volumeState.value;
		if (!media) return;
		this.#core.setInput(this.#slider.input.current);
		this.#core.setMedia(media);
		const state = this.#core.getState();
		const cssVars = getSliderCSSVars(this.#slider.adjustForAlignment(state));
		const thumbAttrs = this.#core.getAttrs(state);
		applyStyles(this, cssVars);
		applyStateDataAttrs(this, state, VolumeSliderDataAttrs);
		applyElementProps(this, { hidden: state.hidden ? "" : void 0 });
		this.#provider.setValue({
			state,
			stateAttrMap: VolumeSliderDataAttrs,
			pointerValue: this.#core.valueFromPercent(state.pointerPercent),
			thumbAttrs: {
				...thumbAttrs,
				"aria-label": translateText(thumbAttrs["aria-label"], this.#i18n.value),
				"aria-valuetext": translateText(thumbAttrs["aria-valuetext"], this.#i18n.value, this.#core.getValueTextParams(state))
			},
			thumbProps: this.#slider.thumbProps,
			formatValue: (value) => `${Math.round(value)}%`
		});
	}
	#setVolume(percent) {
		this.#volumeState.value?.setVolume(this.#core.valueFromPercent(percent) / 100);
	}
};

//#endregion
//#region ../html/dist/default/define/ui/compounds.js
function defineMenu() {
	safeDefine(MenuElement);
	safeDefine(MenuItemElement);
	safeDefine(MenuGroupLabelElement);
	safeDefine(MenuSeparatorElement);
	safeDefine(MenuGroupElement);
	safeDefine(MenuRadioGroupElement);
	safeDefine(MenuRadioItemElement);
	safeDefine(MenuCheckboxItemElement);
	safeDefine(MenuItemIndicatorElement);
}
function defineControls() {
	safeDefine(ControlsElement);
	safeDefine(ControlsGroupElement);
}
function defineErrorDialog() {
	safeDefine(ErrorDialogElement);
	safeDefine(AlertDialogCloseElement);
	safeDefine(AlertDialogDescriptionElement);
	safeDefine(AlertDialogTitleElement);
}
function defineInputIndicators() {
	safeDefine(StatusAnnouncerElement);
	safeDefine(StatusIndicatorElement);
	safeDefine(StatusIndicatorValueElement);
	safeDefine(VolumeIndicatorElement);
	safeDefine(VolumeIndicatorFillElement);
	safeDefine(VolumeIndicatorValueElement);
	safeDefine(SeekIndicatorElement);
	safeDefine(SeekIndicatorValueElement);
}
/** Shared slider sub-elements used by all slider types. */
function defineSliderParts() {
	safeDefine(SliderFillElement);
	safeDefine(SliderPreviewElement);
	safeDefine(SliderThumbElement);
	safeDefine(SliderTrackElement);
	safeDefine(SliderValueElement);
}
function defineTime() {
	safeDefine(TimeElement);
	safeDefine(TimeGroupElement);
	safeDefine(TimeSeparatorElement);
}
function defineTooltip() {
	safeDefine(TooltipGroupElement);
	safeDefine(TooltipLabelElement);
	safeDefine(TooltipShortcutElement);
	safeDefine(TooltipElement);
}
function defineSliders() {
	safeDefine(TimeSliderElement);
	safeDefine(VolumeSliderElement);
	defineSliderParts();
	safeDefine(SliderBufferElement);
	safeDefine(SliderThumbnailElement);
}

//#endregion
//#region ../html/dist/default/define/video/ui.js
safeDefine(VideoPlayerElement);
safeDefine(MediaContainerElement);
safeDefine(I18nProviderElement);
defineControls();
defineErrorDialog();
defineInputIndicators();
defineSliders();
safeDefine(TimeSliderChaptersElement);
safeDefine(TimeSliderChapterTitleElement);
defineTime();
defineMenu();
defineTooltip();
safeDefine(AirPlayButtonElement);
safeDefine(AudioTrackRadioGroupElement);
safeDefine(BufferingIndicatorElement);
safeDefine(CaptionsButtonElement);
safeDefine(CastButtonElement);
safeDefine(FullscreenButtonElement);
safeDefine(GestureElement);
safeDefine(HotkeyElement);
safeDefine(LiveButtonElement);
safeDefine(MuteButtonElement);
safeDefine(PiPButtonElement);
safeDefine(PlayButtonElement);
safeDefine(PlaybackRateButtonElement);
safeDefine(PlaybackRateRadioGroupElement);
safeDefine(CaptionsRadioGroupElement);
safeDefine(PopoverElement);
safeDefine(PosterElement);
safeDefine(QualityRadioGroupElement);
safeDefine(SeekButtonElement);
safeDefine(TextElement);

//#endregion
//#region ../html/dist/default/_virtual/inline-css_src/define/video/skin.js
var skin_default = "video-player,live-video-player,media-i18n{display:contents}video-player video,video-player [slot=poster],live-video-player video,live-video-player [slot=poster]{width:100%;height:100%;display:block}video-player video::-webkit-media-text-track-container,live-video-player video::-webkit-media-text-track-container{z-index:1;scale:.98;translate:0 var(--media-caption-track-y,0);transition:translate var(--media-caption-track-duration,0) ease-out;transition-delay:var(--media-caption-track-delay,0);font-family:inherit}media-tooltip-group{display:contents}:host{width:100%;display:grid}media-container{min-width:0;min-height:0}.media-popover--volume:has(media-volume-slider[data-hidden]){display:none}.media-sr-only{white-space:nowrap;clip:rect(0, 0, 0, 0);border:0;width:1px;height:1px;margin:-1px;padding:0;position:absolute;overflow:hidden}.media-default-skin *,.media-default-skin :before,.media-default-skin :after{box-sizing:border-box}.media-default-skin img,.media-default-skin video,.media-default-skin svg{max-width:100%;display:block}.media-default-skin button{font:inherit}.media-default-skin [hidden][hidden]{display:none}@media (prefers-reduced-motion:no-preference){.media-default-skin{interpolate-size:allow-keywords}}.media-default-skin{--accent-color:var(--media-accent-color,var(--default-accent-color));--accent-contrast-color:contrast-color(var(--accent-color));--accent-background-color:var(--media-accent-color,oklch(from var(--default-accent-color) l c h / calc(alpha * .1)));--accent-text-color:var(--media-accent-text-color,contrast-color(var(--media-accent-color,oklch(0% 0 0))));--shadow-current-color:oklch(from currentColor 0 0 0 / clamp(0, calc((l - .5) * .5), .15));--shadow-subtle-current-color:oklch(from var(--shadow-current-color) l c h / calc(alpha * .4));--scrollbar-thumb-color:oklch(from currentColor l c h / .3);--scale:1;--scale-unit:var(--media-scale-unit,16px);--size:calc(var(--scale-unit) * var(--scale));--spacing:calc(var(--size) / 4);--font-size-medium:calc(.9375 * var(--size));--font-size-base:calc(.8125 * var(--size));--font-size-small:calc(.6875 * var(--size));--font-size-tiny:calc(.5625 * var(--size));--media-icon-size:calc(1.125 * var(--size));--container-border-radius:var(--media-border-radius,1.75rem);width:100%;height:100%;font-family:Inter Variable,Inter,ui-sans-serif,system-ui,sans-serif;font-size:var(--font-size-base);-webkit-font-smoothing:auto;-moz-osx-font-smoothing:auto;letter-spacing:normal;outline-offset:-4px;scrollbar-color:var(--scrollbar-thumb-color) transparent;scrollbar-width:thin;border-radius:var(--container-border-radius,1.75rem);isolation:isolate;outline:2px solid #0000;line-height:1.5;transition-property:outline-offset,outline-color;transition-duration:.1s;transition-timing-function:ease-out;display:block;position:relative;container:media-root/inline-size;&:focus-visible{outline-color:var(--focus-ring-color);outline-offset:2px}&::-webkit-scrollbar-thumb{background:var(--scrollbar-thumb-color);border-radius:9999px}@media (prefers-reduced-transparency:reduce) or (prefers-contrast:more){--scrollbar-thumb-color:oklch(from currentColor l c h / .8);scrollbar-width:auto}}.media-default-skin .media-surface{background-color:var(--surface-background-color);box-shadow:0 0 0 1px var(--surface-outer-border-color), 0 1px 3px 0 var(--surface-shadow-color), 0 1px 2px -1px var(--surface-shadow-color);backdrop-filter:var(--surface-backdrop-filter);&:after{z-index:10;pointer-events:none;content:\"\";border-radius:inherit;box-shadow:inset 0 1px 0 0 var(--surface-inner-border-color), inset 0 0 0 1px oklch(from var(--surface-inner-border-color) l c h / calc(alpha * .5));position:absolute;inset:0}}.media-default-skin ::slotted(video),.media-default-skin video{object-fit:var(--media-object-fit,contain);object-position:var(--media-object-position,center);width:100%;height:100%;display:block}.media-default-skin ::slotted(video){border-radius:var(--container-border-radius)}.media-default-skin video{border-radius:inherit}.media-default-skin:fullscreen ::slotted(video),.media-default-skin:fullscreen video{object-fit:contain}.media-default-skin .media-overlay{pointer-events:none;border-radius:inherit;opacity:0;backdrop-filter:blur()saturate();transition-timing-function:ease-out;transition-duration:var(--controls-transition-duration);background-image:linear-gradient(oklch(0% 0 0/0),oklch(0% 0 0/.3) 75%,oklch(0% 0 0/.5));transition-property:opacity,backdrop-filter;position:absolute;inset:0}.media-default-skin .media-error~.media-overlay{transition-delay:var(--error-dialog-transition-delay);transition-duration:var(--error-dialog-transition-duration)}.media-default-skin .media-controls[data-visible]~.media-overlay,.media-default-skin .media-error[data-open]~.media-overlay{opacity:1}.media-default-skin .media-buffering-indicator[data-visible]~.media-overlay{opacity:1;backdrop-filter:blur(8px);background:oklch(0% 0 0/.35)}.media-default-skin .media-error[data-open]~.media-overlay{backdrop-filter:blur(16px)saturate(1.5)}.media-default-skin .media-buffering-indicator{z-index:10;color:oklch(100% 0 0);pointer-events:none;place-content:center;display:none;position:absolute;inset:0;&:not([data-visible]){--media-spinner-animation:none}&[data-visible]{display:grid}}.media-default-skin .media-error{outline:none}.media-default-skin .media-error:not([data-open]){display:none}.media-default-skin .media-error__title{font-weight:600;line-height:1.25}.media-default-skin .media-error__description{overflow-wrap:anywhere;opacity:.7}.media-default-skin .media-error__actions{gap:calc(var(--spacing) * 2);display:flex;&>*{flex:1}}.media-default-skin .media-error[data-open]~.media-controls *{visibility:hidden}.media-default-skin .media-controls{--media-popover-side-offset:calc(var(--spacing) * (var(--base-side-offset,2) + 1));--media-tooltip-side-offset:var(--media-popover-side-offset);--media-popover-boundary-offset:calc(var(--spacing) * var(--base-boundary-offset,2));--media-tooltip-boundary-offset:var(--media-popover-boundary-offset);padding:calc(var(--spacing) * 1);text-shadow:0 1px 0 var(--shadow-current-color);border-radius:3.40282e38px;align-items:center;display:flex;container:media-controls/inline-size}.media-default-skin .media-time-controls{gap:calc(var(--spacing) * 2.5);flex:1;align-items:center;display:flex;container:media-time-controls/inline-size;&>.media-time:last-child{@container media-time-controls (width<16rem){display:none}}}.media-default-skin .media-time{font-variant-numeric:tabular-nums}.media-default-skin .media-time[role=button]{cursor:pointer;outline-offset:-2px;border-radius:calc(var(--spacing) * 1);outline:2px solid #0000;transition-property:outline-color,outline-offset;transition-duration:.1s;transition-timing-function:ease-out;&:focus-visible{outline-color:var(--focus-ring-color);outline-offset:2px}}.media-default-skin .media-button{height:calc(var(--spacing) * 9);min-height:0;padding:calc(var(--spacing) * 2) calc(var(--spacing) * 4);text-align:center;touch-action:manipulation;cursor:pointer;user-select:none;outline-offset:-2px;will-change:scale;border:none;border-radius:3.40282e38px;outline:2px solid #0000;flex-shrink:0;justify-content:center;align-items:center;transition-property:background-color,color,outline-offset,scale;transition-duration:.15s;transition-timing-function:ease-out;display:flex;&:focus-visible{outline-color:var(--focus-ring-color);outline-offset:2px}&:active:not([aria-disabled=true]){scale:.98}&[aria-disabled=true]{cursor:not-allowed;opacity:.5}}.media-default-skin .media-button--primary{color:var(--accent-contrast-color);text-shadow:none;background:var(--accent-color);font-weight:500}.media-default-skin .media-button--subtle{color:inherit;text-shadow:inherit;background:0 0;&:not([aria-disabled=true]){&:hover,&:focus-visible,&[aria-expanded=true]{color:var(--accent-text-color);background-color:var(--accent-background-color);text-decoration:none}}}.media-default-skin .media-button--icon{aspect-ratio:1;padding:0;display:grid;&:active:not([aria-disabled=true]){scale:.9}& .media-icon__container{display:grid}& .media-icon{transition-behavior:allow-discrete;filter:drop-shadow(0 1px 0 var(--shadow-current-color));grid-area:1/1;transition-property:display,opacity;transition-duration:.15s;transition-timing-function:ease-out}}.media-default-skin .media-button--seek{& .media-icon__label{font-variant-numeric:tabular-nums;letter-spacing:-.05em;font-size:.715em;font-weight:500;position:absolute;bottom:-3px;right:-1px}&:has(.media-icon--flipped) .media-icon__label{right:unset;left:-1px}}.media-default-skin .media-button--playback-rate{font-variant-numeric:tabular-nums;padding:0;&:after{content:attr(data-rate) \"×\";width:4ch}&[data-inline-rate-label]:after{content:none}}.media-default-skin .media-button--settings{& .media-icon--settings{transition:transform .15s ease-in-out;@media (prefers-reduced-motion:reduce){transition-duration:0s}}&[aria-expanded=true] .media-icon--settings{transform:rotate(90deg)}}.media-default-skin .media-button--live{gap:calc(var(--spacing) * 1.5);aspect-ratio:auto;width:auto;padding:calc(var(--spacing) * 2) calc(var(--spacing) * 3);font-size:var(--font-size-small);text-transform:uppercase;letter-spacing:.05em;align-items:center;font-weight:600;line-height:1;display:inline-flex;&:before{width:calc(var(--spacing) * 2);height:calc(var(--spacing) * 2);content:\"\";background-color:oklch(from currentColor l c h / .4);border-radius:50%;flex-shrink:0;transition:background-color .15s ease-out;display:inline-block}&[data-live-edge]:before{background-color:oklch(65% .22 27)}}.media-default-skin .media-button-group{align-items:center;gap:1px;display:flex}.media-default-skin .media-badge{padding:calc(var(--spacing) * .5) calc(var(--spacing) * 1.5);font-size:var(--font-size-small);color:oklch(from currentColor l c h / .85);white-space:nowrap;background-color:oklch(from currentColor l c h / .1);border-radius:3.40282e38px;font-weight:500;line-height:1}.media-default-skin .media-icon__container{position:relative}.media-default-skin .media-icon{width:var(--media-icon-size);height:var(--media-icon-size);flex-shrink:0}.media-default-skin .media-icon--flipped{scale:-1 1}.media-default-skin media-poster,.media-default-skin>img{pointer-events:none;width:100%;height:100%;transition:opacity .25s;position:absolute;inset:0}.media-default-skin media-poster:not([data-visible]),.media-default-skin>img:not([data-visible]),.media-default-skin>img[data-visible]:not([data-loaded]){opacity:0}.media-default-skin media-poster ::slotted(img),.media-default-skin media-poster img{object-fit:var(--media-object-fit,contain);object-position:var(--media-object-position,center);border-radius:var(--container-border-radius);width:100%;height:100%;position:absolute;inset:0}.media-default-skin>img{object-fit:var(--media-object-fit,contain);object-position:var(--media-object-position,center);border-radius:inherit}.media-default-skin media-poster:before,.media-default-skin:before{pointer-events:none;content:\"\";background-image:var(--media-poster-placeholder,none);background-repeat:no-repeat;background-position:var(--media-object-position,center);background-size:var(--media-object-fit,contain);filter:blur(var(--media-poster-placeholder-blur,20px));position:absolute;inset:0}.media-default-skin:before{opacity:0;transition:opacity .25s}.media-default-skin:has(img[data-visible]:not([data-loaded])):before{opacity:1}.media-default-skin:fullscreen media-poster ::slotted(img),.media-default-skin:fullscreen media-poster img,.media-default-skin:fullscreen>img{object-fit:contain}.media-default-skin .media-thumbnail{pointer-events:none;border-radius:calc(var(--spacing) * 3);background-color:oklch(0% 0 0/.9);position:relative;& .media-thumbnail__image{max-width:var(--thumbnail-max-width);max-height:var(--max-height);border-radius:inherit;display:block;position:relative;overflow:clip;&:after{content:\"\";border-radius:inherit;background-image:linear-gradient(oklch(0% 0 0/0),oklch(0% 0 0/.1),oklch(0% 0 0/.5));position:absolute;inset:0}}& .media-thumbnail__spinner{opacity:0;position:absolute;top:50%;left:50%;translate:-50% -50%}& .media-thumbnail__image,& .media-thumbnail__spinner{transition:opacity .15s ease-out}&:not(:has(.media-thumbnail__image[data-loading])){& .media-thumbnail__spinner{--media-spinner-animation:none}}&:has(.media-thumbnail__image[data-loading]){width:var(--thumbnail-max-width);aspect-ratio:16/9;max-width:100%;overflow:hidden;& .media-thumbnail__image{opacity:0}& .media-thumbnail__spinner{opacity:1}}}.media-default-skin .media-slider{cursor:pointer;border-radius:3.40282e38px;outline:none;flex:1;justify-content:center;align-items:center;display:flex;position:relative;&[data-orientation=horizontal]{width:var(--slider-width,100%);min-width:calc(var(--spacing) * 20);height:var(--slider-height,calc(var(--spacing) * 8))}&[data-orientation=vertical]{width:var(--slider-width,calc(var(--spacing) * 8));height:var(--slider-height,calc(var(--spacing) * 20))}& .media-slider__track{user-select:none;background-color:oklch(from currentColor l c h / .2);border-radius:inherit;isolation:isolate;position:relative;overflow:hidden;&[data-orientation=horizontal]{width:100%;height:calc(var(--spacing) * 1)}&[data-orientation=vertical]{width:calc(var(--spacing) * 1);height:100%}}& .media-slider__thumb{z-index:10;width:calc(var(--spacing) * 2.5);height:calc(var(--spacing) * 2.5);user-select:none;outline-offset:-4px;box-shadow:0 0 0 1px var(--shadow-current-color,oklch(0% 0 0/.1)), 0 1px 3px 0 oklch(0% 0 0/.35), 0 1px 2px -1px oklch(0% 0 0/.35);opacity:0;background-color:currentColor;border-radius:3.40282e38px;outline:4px solid #0000;transition-property:opacity,height,width,outline-offset;transition-duration:.15s;transition-timing-function:ease-out;position:absolute;translate:-50% -50%;&[data-orientation=horizontal]{top:50%;left:var(--media-slider-fill)}&[data-orientation=vertical]{top:calc(100% - var(--media-slider-fill));left:50%}&:hover,&:focus{outline-color:oklch(from currentColor l c h / .15);outline-offset:0}&:after{content:\"\";border-radius:inherit;transition-property:opacity,scale;transition-duration:.15s;transition-timing-function:ease-out;position:absolute;inset:-4px;box-shadow:0 0 0 2px}&:not(:focus-visible):after{opacity:0;scale:.5}}&:active .media-slider__thumb,&:focus-within .media-slider__thumb,& .media-slider__thumb--persistent{width:calc(var(--spacing) * 3);height:calc(var(--spacing) * 3)}&:hover .media-slider__thumb,& .media-slider__thumb:focus-visible,& .media-slider__thumb--persistent{opacity:1}& .media-slider__buffer,& .media-slider__fill{pointer-events:none;border-radius:inherit;position:absolute;&[data-orientation=horizontal]{inset-block:0;transition-property:width;left:0}&[data-orientation=vertical]{inset-inline:0;transition-property:height;bottom:0}}& .media-slider__buffer{background-color:oklch(from currentColor l c h / .2);&[data-orientation=horizontal]{width:var(--media-slider-buffer)}&[data-orientation=vertical]{height:var(--media-slider-buffer)}}& .media-slider__fill{background-color:var(--accent-color);&[data-orientation=horizontal]{width:var(--media-slider-fill)}&[data-orientation=vertical]{height:var(--media-slider-fill)}}& .media-slider__chapters{border-radius:inherit;flex:1;align-items:center;min-width:0;min-height:0;display:flex;position:relative;&[data-orientation=horizontal]{width:100%;height:100%}&[data-orientation=vertical]{flex-direction:column-reverse;width:100%;height:100%}}& .media-slider__chapter{--chapter-gap:calc(var(--spacing) * 1);--chapter-inset-start:.5;--chapter-inset-end:.5;justify-content:center;align-items:center;min-width:0;min-height:0;display:flex;position:absolute;inset:0;&:first-child{--chapter-inset-start:0}&:last-child{--chapter-inset-end:0}& .media-slider__chapter-track{--chapter-track-size:calc(var(--spacing) * 1);--chapter-track-highlighted-size:calc(var(--spacing) * 1.75);--chapter-track-border-radius:calc(Infinity * 1px);border-radius:var(--chapter-track-border-radius);@media (prefers-reduced-motion:no-preference){transition:height .2s ease-out,width .2s ease-out}}&[data-orientation=horizontal]{clip-path:inset(0 calc(100% - var(--media-slider-chapter-end)) 0 var(--media-slider-chapter-start));& .media-slider__chapter-track{height:var(--chapter-track-size);clip-path:inset(0 calc(100% - var(--media-slider-chapter-end) + var(--chapter-gap) * var(--chapter-inset-end)) 0 calc(var(--media-slider-chapter-start) + var(--chapter-gap) * var(--chapter-inset-start)) round var(--chapter-track-border-radius))}&[data-highlighted] .media-slider__chapter-track{height:var(--chapter-track-highlighted-size)}}&[data-orientation=vertical]{clip-path:inset(calc(100% - var(--media-slider-chapter-end)) 0 var(--media-slider-chapter-start) 0);& .media-slider__chapter-track{width:var(--chapter-track-size);clip-path:inset(calc(100% - var(--media-slider-chapter-end) + var(--chapter-gap) * var(--chapter-inset-end)) 0 calc(var(--media-slider-chapter-start) + var(--chapter-gap) * var(--chapter-inset-start)) 0 round var(--chapter-track-border-radius))}&[data-highlighted] .media-slider__chapter-track{width:var(--chapter-track-highlighted-size)}}}&[data-dragging]{& .media-slider__thumb[data-orientation=horizontal]{left:var(--media-slider-pointer)}& .media-slider__thumb[data-orientation=vertical]{top:calc(100% - var(--media-slider-pointer))}& .media-slider__fill[data-orientation=horizontal]{width:var(--media-slider-pointer)}& .media-slider__fill[data-orientation=vertical]{height:var(--media-slider-pointer)}}@media (prefers-reduced-motion:no-preference){& .media-slider__thumb{transition-property:opacity,height,width,outline-offset,left,top}& .media-slider__fill{transition-duration:.2s;transition-timing-function:linear}& .media-slider__buffer{transition-duration:.25s;transition-timing-function:ease-out}}&[data-dragging],&[data-seeking]{& .media-slider__thumb,& .media-slider__fill,& .media-slider__buffer{transition-duration:0s}}& .media-slider__preview{--max-width:min(calc(var(--spacing) * 48), 100cqi);--max-height:calc(var(--spacing) * 32);min-width:var(--max-width);height:calc(var(--spacing) * 1);& .media-slider__thumbnail,& .media-slider__value{max-width:var(--max-width);opacity:0;filter:blur(8px);transform-origin:bottom;scale:.8;translate:-50% calc(var(--spacing) * 2);transition-duration:.15s;transition-timing-function:ease-out;position:absolute;left:50%}& .media-slider__thumbnail{--thumbnail-max-width:var(--max-width);bottom:calc(100% + (var(--spacing) * 9))}& .media-slider__value{bottom:calc(100% + (var(--spacing) * 10.5));text-shadow:0 1px 0 var(--shadow-current-color);flex-direction:column;align-items:center;display:flex}& .media-slider__chapter-title{min-width:0;max-width:var(--max-width);padding-inline:calc(var(--spacing) * 3);text-overflow:ellipsis;white-space:nowrap;overflow:hidden;&:empty{display:none}}&:before{z-index:1;width:calc(var(--spacing) * 1);height:calc(var(--spacing) * 1);pointer-events:none;content:\"\";box-shadow:0 0 0 1px var(--shadow-current-color,oklch(0% 0 0/.15)), 0 1px 2px 0 oklch(0% 0 0/.35);opacity:0;background-color:currentColor;border-radius:100%;transition-property:opacity,scale;transition-duration:.2s;transition-timing-function:ease-out;position:absolute;top:50%;left:50%;translate:-50% -50%;scale:.5}&[data-pointing]:not([data-dragging]):before,&[data-pointing] :is(.media-slider__thumbnail,.media-slider__value),&[data-interactive]:not([data-pointing]):not([data-dragging]) :is(.media-slider__value,.media-slider__thumbnail){opacity:1;filter:blur();scale:1}}}.media-default-skin{--popup-transition:opacity var(--popup-transition-timing-function) var(--popup-transition-duration), filter var(--popup-transition-timing-function) var(--popup-transition-duration), transform var(--popup-transition-timing-function) var(--popup-transition-duration), scale var(--popup-transition-timing-function) var(--popup-transition-duration)}.media-default-skin .media-popover,.media-default-skin .media-tooltip{--popup-translate-distance:calc(.5 * var(--scale-unit));color:inherit;transition:var(--popup-transition);border:0;margin:0;overflow:visible;&[data-starting-style],&[data-ending-style]{opacity:0;filter:blur(4px);transform:translate(var(--popup-translate-x-distance,0), var(--popup-translate-y-distance,0));scale:.95}&[data-ending-style]{transition-duration:max(0s, calc(var(--popup-transition-duration) - 50ms));transform:none}&[data-side=top]{--popup-translate-y-distance:var(--popup-translate-distance);transform-origin:bottom}&[data-side=bottom]{--popup-translate-y-distance:calc(var(--popup-translate-distance) * -1);transform-origin:top}&[data-side=left]{--popup-translate-x-distance:var(--popup-translate-distance);transform-origin:100%}&[data-side=right]{--popup-translate-x-distance:calc(var(--popup-translate-distance) * -1);transform-origin:0}&:before{pointer-events:inherit;content:\"\";position:absolute}&[data-side=top]:before,&[data-side=bottom]:before{width:100%;inset-inline:0}&[data-side=top]:before{top:100%}&[data-side=bottom]:before{bottom:100%}&[data-side=left]:before,&[data-side=right]:before{height:100%;inset-block:0}&[data-side=left]:before{left:100%}&[data-side=right]:before{right:100%}}.media-default-skin .media-popover{&[data-side=top]:before,&[data-side=bottom]:before{height:var(--media-popover-side-offset)}&[data-side=left]:before,&[data-side=right]:before{width:var(--media-popover-side-offset)}}.media-default-skin .media-popover--volume{padding:calc(var(--spacing) * 3) 0;border-radius:3.40282e38px;&:has(media-volume-slider[data-hidden]){display:none}}.media-default-skin .media-tooltip{padding:calc(var(--spacing) * 1) calc(var(--spacing) * 2.5);font-size:var(--font-size-base);white-space:nowrap;border-radius:3.40282e38px;&[data-open]{column-gap:calc(var(--spacing) * 1);align-items:center;display:flex}&[data-side=top]:before,&[data-side=bottom]:before{height:var(--media-tooltip-side-offset)}&[data-side=left]:before,&[data-side=right]:before{width:var(--media-tooltip-side-offset)}& .media-tooltip__kbd{min-width:1.5em;font-family:inherit;font-size:var(--font-size-small);text-align:center;background-color:oklch(from currentColor l c h / .3);border-radius:calc(var(--spacing) * 1);padding:.1em;font-weight:600;line-height:1.25}}.media-default-skin .media-menu{--menu-transition-duration:.25s;--menu-max-height:calc(var(--spacing) * 56);--menu-padding:calc(var(--spacing) * 1);--menu-border-radius:calc(var(--spacing) * 3);--menu-item-border-radius:calc(var(--menu-border-radius) - var(--menu-padding));box-sizing:border-box;min-width:max-content;max-width:var(--media-popover-available-width,none);max-height:min(var(--media-popover-available-height,var(--menu-max-height)), var(--menu-max-height));padding:var(--menu-padding);overscroll-behavior:none;border-radius:var(--menu-border-radius);overflow:auto;@media (prefers-reduced-motion:reduce){--menu-transition-duration:0s}&>.media-menu__panel{inset-inline:0;z-index:10;max-height:inherit;padding:var(--menu-padding);overscroll-behavior:none;transition-timing-function:ease-out;transition-duration:var(--menu-transition-duration);will-change:translate, filter;outline:none;transition-property:translate,filter;position:absolute;top:0;overflow:auto;translate:0;&:where([data-starting-style],[data-ending-style]){pointer-events:none;filter:blur(8px);overflow:hidden;translate:100%}}& .media-menu__separator{margin-block:calc(var(--spacing) * 1);border-bottom:1px solid oklch(0% 0 0/.1);box-shadow:0 1px oklch(100% 0 0/.075)}& .media-menu__group{anchor-scope:--menu-item-highlight-anchor;gap:calc(var(--spacing) * .5);flex-direction:column;display:flex;@supports (top:anchor(top)){&:before{position-anchor:--menu-item-highlight-anchor;inset:anchor(inside);overflow-anchor:none;pointer-events:none;content:\"\";background-color:var(--accent-background-color);border-radius:var(--menu-item-border-radius);transition:inset .1s ease-in-out;position:absolute}}}& .media-menu__item,& .media-menu__back{gap:calc(var(--spacing) * 1.5);padding:calc(var(--spacing) * 1.5) calc(var(--spacing) * 2);text-align:left;text-shadow:0 1px 0 var(--shadow-current-color);cursor:pointer;user-select:none;outline-offset:-2px;border-radius:var(--menu-item-border-radius);outline:2px solid #0000;align-items:center;transition:background-color .1s ease-in-out,color .1s ease-in-out;display:flex;position:relative;& .media-icon{color:oklch(from currentColor l c h / .65);filter:drop-shadow(0 1px 0 var(--shadow-current-color));flex-shrink:0}&:focus-visible{outline-color:var(--focus-ring-color);outline-offset:2px}&:hover,&[data-highlighted]{color:var(--accent-text-color);background-color:var(--accent-background-color);& .media-icon{color:inherit}}@supports (top:anchor(top)){transition-duration:50ms;&:hover,&[data-highlighted]{transition-duration:.2s}}}& .media-menu__indicator{margin-right:calc(var(--spacing) * -1);opacity:0;flex-shrink:0;margin-left:auto;& .media-icon{filter:drop-shadow(0 1px 0 var(--shadow-current-color))}}& .media-menu__item{font-variant-numeric:tabular-nums;color:inherit;justify-content:space-between;&[aria-disabled=true]{pointer-events:none;cursor:not-allowed;opacity:.5}&[aria-checked=true] .media-menu__indicator{opacity:1}&[data-availability=unavailable],&[data-availability=unsupported]{display:none}&:hover,&[data-highlighted]{@supports (top:anchor(top)){anchor-name:--menu-item-highlight-anchor;background-color:#0000}}}& .media-menu__tier{padding-top:1px;padding-left:calc(var(--spacing) * .5);font-size:var(--font-size-tiny);color:oklch(from currentColor l c h / .7);font-weight:600;line-height:1}& .media-menu__back{width:100%;margin-bottom:calc(var(--spacing) * .5)}& .media-menu__hint{gap:calc(var(--spacing) * 1);min-width:0;padding-left:calc(var(--spacing) * 2);color:oklch(from currentColor l c h / .65);align-items:center;margin-left:auto;display:inline-flex}& .media-menu__hint-label{max-width:calc(var(--spacing) * 24);text-overflow:ellipsis;white-space:nowrap;overflow:hidden}& .media-menu__chevron{width:calc(var(--spacing) * 3.5);height:calc(var(--spacing) * 3.5)}&.media-menu--settings{width:var(--media-menu-width);min-width:calc(var(--spacing) * 48);height:var(--media-menu-height);transition:var(--popup-transition), width var(--popup-transition-timing-function) var(--menu-transition-duration), height var(--popup-transition-timing-function) var(--menu-transition-duration);overflow:hidden;&>:not([data-submenu]){transition:translate var(--menu-transition-duration) ease-out, filter var(--menu-transition-duration) ease-out;will-change:translate, filter;translate:0}&[data-submenu-expanded=true]>:not([data-submenu]){filter:blur(8px);translate:-100%}&[data-submenu-expanded]>:not([data-submenu]):before{display:none}&[data-starting-style],&[data-ending-style]{transition:var(--popup-transition)}}}.media-default-skin{--media-caption-track-duration:var(--controls-transition-duration);--media-caption-track-delay:25ms;--media-caption-track-y:calc(var(--spacing) * -2);&:has(.media-controls[data-visible]){--media-caption-track-y:calc(var(--spacing) * -14)}}.media-default-skin video::-webkit-media-text-track-container{z-index:1;scale:.98;translate:0 var(--media-caption-track-y);transition:translate var(--media-caption-track-duration) ease-out;transition-delay:var(--media-caption-track-delay);font-family:inherit}.media-default-skin .media-input-indicator-overlay{color:oklch(100% 0 0);pointer-events:none;grid-template-columns:1fr 1fr 1fr;place-items:center;display:grid;position:absolute;inset:0}.media-default-skin{& .media-volume-indicator,& .media-status-indicator--state{--surface-background-color:oklch(0% 0 0/.25);top:calc(var(--spacing) * 3);color:inherit;pointer-events:none;transform-origin:top;border-radius:3.40282e38px;font-weight:500;transition-duration:.1s;transition-timing-function:ease-out;position:absolute;& .media-volume-indicator__content,& .media-status-indicator__content{gap:calc(var(--spacing) * 2);width:100%;padding:calc(var(--spacing) * 1) calc(var(--spacing) * 2.5);justify-content:space-between;align-items:center;display:flex;& *{mix-blend-mode:difference}}& .media-icon{flex-shrink:0;display:none}& .media-volume-indicator__value,& .media-status-indicator__value{margin-left:auto}@media (pointer:coarse){will-change:scale, translate, opacity;transition-property:scale,translate,opacity}@media (pointer:fine) and (prefers-reduced-motion:no-preference){will-change:scale, translate, filter, opacity;transition-property:scale,translate,filter,opacity}@media (prefers-reduced-transparency:reduce) or (prefers-contrast:more){--surface-background-color:oklch(0% 0 0)}&[data-starting-style],&[data-ending-style]{opacity:0;transition-duration:.25s;transition-timing-function:ease-in;@media (pointer:fine) and (prefers-reduced-motion:no-preference){filter:blur(8px);scale:.9}@media (prefers-reduced-motion:no-preference){&[data-ending-style]{translate:0 -25%}}}}& .media-seek-indicator,& .media-status-indicator--playback{padding:calc(var(--spacing) * 4);text-align:center;grid-area:1/2;place-content:center;display:grid}}.media-default-skin .media-volume-indicator{width:min(80%, calc(var(--spacing) * 48));transform:translate(0);& .media-volume-indicator__content{background-image:linear-gradient(currentColor,currentColor);background-position:0;background-repeat:no-repeat;background-size:var(--media-volume-fill,0%) 100%;border-radius:inherit;transition:background-size .2s linear}&[data-level=high] .media-icon--volume-high,&[data-level=low] .media-icon--volume-low,&[data-level=off] .media-icon--volume-off{display:block}@media (prefers-reduced-motion:no-preference){&[data-min],&[data-max]{transition:transform .3s linear(0, -24 20%, 16 40%, -8 60%, 4 80%, 1);transform:translate(.25px)}}}.media-default-skin .media-status-indicator--state{&[data-status=captions-on] .media-icon--captions-on,&[data-status=captions-off] .media-icon--captions-off,&[data-status=fullscreen] .media-icon--fullscreen-enter,&[data-status=exit-fullscreen] .media-icon--fullscreen-exit,&[data-status=pip] .media-icon--pip-enter,&[data-status=exit-pip] .media-icon--pip-exit{display:block}}.media-default-skin .media-status-indicator--playback{backdrop-filter:blur(8px);background:oklch(0% 0 0/.35);border-radius:100%;transition-property:opacity,scale;transition-duration:.2s;transition-timing-function:ease-out;& .media-icon{width:calc(var(--media-icon-size) * 1.5);height:calc(var(--media-icon-size) * 1.5);display:none;&.media-icon--play{translate:1px}}&[data-status=pause] .media-icon--pause,&[data-status=play] .media-icon--play{display:block}&[data-starting-style],&[data-ending-style]{opacity:0;scale:.85}&[data-ending-style]{transition-duration:.1s;transition-timing-function:ease-in}@media (prefers-reduced-motion:reduce){transition-property:opacity;transition-duration:50ms}}.media-default-skin .media-seek-indicator{gap:calc(var(--spacing) * 1);& .media-seek-indicator__value{font-variant-numeric:tabular-nums}@container media-root (width>24rem){padding:calc(var(--spacing) * 6)}&[data-direction=backward]{grid-column:1;justify-self:left}&[data-direction=forward]{grid-column:3;justify-self:right}& .media-icon--seek{width:calc(var(--media-icon-size) * 1.5);height:calc(var(--media-icon-size) * 1.5);display:block}&[data-direction=backward] .media-icon--seek{scale:-1 1}@media (prefers-reduced-motion:no-preference){& .media-icon--seek{transition-property:translate,opacity;transition-duration:.2s;transition-timing-function:ease-in-out}&[data-starting-style] .media-icon--seek,&[data-ending-style] .media-icon--seek{opacity:0}&[data-direction=forward][data-starting-style] .media-icon--seek{translate:-60%}&[data-direction=backward][data-starting-style] .media-icon--seek{translate:60%}}}.media-button--play .media-icon--restart,.media-button--play .media-icon--play,.media-button--play .media-icon--pause,.media-button--mute .media-icon--volume-off,.media-button--mute .media-icon--volume-low,.media-button--mute .media-icon--volume-high,.media-button--fullscreen .media-icon--fullscreen-enter,.media-button--fullscreen .media-icon--fullscreen-exit,.media-button--pip .media-icon--pip-enter,.media-button--pip .media-icon--pip-exit,.media-button--cast .media-icon--cast-enter,.media-button--cast .media-icon--cast-exit,.media-button--airplay .media-icon--airplay-enter,.media-button--airplay .media-icon--airplay-exit,.media-button--captions .media-icon--captions-off,.media-button--captions .media-icon--captions-on{opacity:0;display:none}.media-button--play[data-ended] .media-icon--restart,.media-button--play:not([data-ended])[data-paused] .media-icon--play,.media-button--play:not([data-ended]):not([data-started]) .media-icon--play,.media-button--play[data-started]:not([data-paused]):not([data-ended]) .media-icon--pause,.media-button--mute[data-muted] .media-icon--volume-off,.media-button--mute:not([data-muted])[data-volume-level=low] .media-icon--volume-low,.media-button--mute:not([data-muted]):not([data-volume-level=low]) .media-icon--volume-high,.media-button--fullscreen:not([data-fullscreen]) .media-icon--fullscreen-enter,.media-button--fullscreen[data-fullscreen] .media-icon--fullscreen-exit,.media-button--pip:not([data-pip]) .media-icon--pip-enter,.media-button--pip[data-pip] .media-icon--pip-exit,.media-button--cast:not([data-cast-state=connected]) .media-icon--cast-enter,.media-button--cast[data-cast-state=connected] .media-icon--cast-exit,.media-button--airplay:not([data-airplay-state=connected]) .media-icon--airplay-enter,.media-button--airplay[data-airplay-state=connected] .media-icon--airplay-exit,.media-button--captions:not([data-active]) .media-icon--captions-off,.media-button--captions[data-active] .media-icon--captions-on{opacity:1;display:block}.media-button--airplay:not([data-airplay-state=connected]){--media-icon--airplay__fill-animation:none;--media-icon--airplay__triangle-animation:none}.media-default-skin--video{--default-accent-color:oklch(100% 0 0);--border-color:light-dark(oklch(0% 0 0/.1),oklch(100% 0 0/.15));--focus-ring-color:light-dark(oklch(0% 0 0),oklch(100% 0 0));--media-video-border-radius:var(--container-border-radius);--surface-background-color:oklch(100% 0 0/.1);--surface-inner-border-color:oklch(100% 0 0/.1);--surface-outer-border-color:oklch(0% 0 0/.1);--surface-shadow-color:oklch(0% 0 0/.15);--surface-backdrop-filter:blur(16px) saturate(1.5);--controls-transition-duration:.1s;--controls-transition-timing-function:ease-out;--error-dialog-transition-duration:.35s;--error-dialog-transition-delay:.1s;--error-dialog-transition-timing-function:ease-out;--popup-transition-duration:.1s;--popup-transition-timing-function:ease-out;background:oklch(0% 0 0);overflow:clip;@media (prefers-reduced-motion:reduce){--error-dialog-transition-duration:50ms;--error-dialog-transition-delay:0s;--popup-transition-duration:0s}@media (prefers-reduced-transparency:reduce) or (prefers-contrast:more){--surface-background-color:oklch(0% 0 0);--surface-inner-border-color:oklch(100% 0 0/.25);--surface-outer-border-color:transparent}&:has(.media-controls--root:not([data-visible])){@media (pointer:fine){--controls-transition-duration:.3s}@media (pointer:coarse){--controls-transition-duration:.15s}@media (prefers-reduced-motion:reduce){--controls-transition-duration:50ms}}&:after{z-index:10;pointer-events:none;content:\"\";border-radius:inherit;box-shadow:inset 0 0 0 1px var(--border-color);position:absolute;inset:0}&:fullscreen{--container-border-radius:0;&:after{display:none}@media (width>=1280px){--scale:1.25}@media (width>=1536px){--scale:1.5}@media (width>=1920px){--scale:1.75}}}.media-default-skin--video .media-error{z-index:20;justify-content:center;align-items:center;display:flex;position:absolute;inset:0}.media-default-skin--video .media-error__dialog{gap:calc(var(--spacing) * 3);width:100%;max-width:calc(var(--spacing) * 72);padding:calc(var(--spacing) * 3);color:oklch(100% 0 0);text-shadow:0 1px oklch(0% 0 0/.25);border-radius:calc(var(--spacing) * 7);transition-delay:var(--error-dialog-transition-delay);transition-timing-function:var(--error-dialog-transition-timing-function);transition-duration:var(--error-dialog-transition-duration);flex-direction:column;transition-property:opacity,scale;display:flex}.media-default-skin--video .media-error[data-starting-style] .media-error__dialog,.media-default-skin--video .media-error[data-ending-style] .media-error__dialog{opacity:0;scale:.5}.media-default-skin--video .media-error[data-ending-style] .media-error__dialog{transition-delay:0s}.media-default-skin--video .media-error__content{gap:calc(var(--spacing) * 2);padding:calc(var(--spacing) * 2) calc(var(--spacing) * 2) calc(var(--spacing) * 1.5);text-shadow:inherit;flex-direction:column;display:flex}.media-default-skin--video .media-error__title{font-size:var(--font-size-medium)}.media-default-skin--video .media-controls--root{--inset-factor:2;--inset:calc(var(--spacing) * var(--inset-factor));--base-boundary-offset:var(--inset-factor);z-index:10;color:oklch(100% 0 0);transition-timing-function:var(--controls-transition-timing-function);transition-duration:calc(var(--controls-transition-duration) / 2);display:contents;& .media-controls--primary,& .media-controls--secondary{z-index:10;position:absolute}& .media-controls--primary{inset-inline:var(--inset);bottom:var(--inset);transform-origin:bottom}& .media-controls--secondary{top:var(--inset);right:var(--inset);transform-origin:top;container-type:normal}@container media-root (width<32rem){& .media-controls--primary,& .media-controls--secondary{transition-timing-function:inherit;transition-duration:inherit;@media (pointer:fine){will-change:filter, opacity, scale, translate;transition-property:filter,opacity,scale,translate}@media (pointer:coarse){will-change:opacity, scale, translate;transition-property:opacity,scale,translate}}&:after{display:none}&:not([data-visible]){& .media-controls--primary,& .media-controls--secondary{pointer-events:none;opacity:0;transition-duration:var(--controls-transition-duration);scale:.95;@media (pointer:fine) and (prefers-reduced-motion:no-preference){filter:blur(8px)}@media (prefers-reduced-motion:reduce){scale:1}}& .media-controls--primary{@media (prefers-reduced-motion:no-preference){translate:0 4px}}& .media-controls--secondary{@media (prefers-reduced-motion:no-preference){translate:0 -4px}}}}@container media-root (width>=32rem){inset-inline:var(--inset);bottom:var(--inset);transform-origin:bottom;display:flex;position:absolute;& .media-controls--primary,& .media-controls--secondary{display:contents;&:after{display:none}}&:not([data-visible]){pointer-events:none;opacity:0;transition-duration:var(--controls-transition-duration);scale:.95;@media (pointer:fine) and (prefers-reduced-motion:no-preference){filter:blur(8px)}@media (prefers-reduced-motion:reduce){scale:1}@media (prefers-reduced-motion:no-preference){translate:0 4px}}}& .media-time-controls{padding-inline:calc(var(--spacing) * 3);flex:1}@media (pointer:fine){will-change:filter, opacity, scale, translate;transition-property:filter,opacity,scale,translate}@media (pointer:coarse){will-change:opacity, scale, translate;transition-property:opacity,scale,translate}@container media-root (width>42rem){--inset-factor:3}}.media-default-skin--video .media-error[data-open]~.media-controls{display:none}.media-default-skin--video:has(.media-controls--root:not([data-visible])){cursor:none}.media-default-skin--video .media-slider__track{background-color:oklch(100% 0 0/.2)}";

//#endregion
//#region ../html/dist/default/define/video/skin.js
function getTemplateHTML() {
	return `<media-container class="media-default-skin media-default-skin--video"><slot name="media"></slot><slot></slot><media-poster><slot name="poster"></slot></media-poster><media-buffering-indicator class="media-buffering-indicator"> ${renderIcon("spinner", { class: "media-icon" })} </media-buffering-indicator><media-error-dialog class="media-error"><div class="media-error__dialog media-surface"><div class="media-error__content"><media-alert-dialog-title class="media-error__title"></media-alert-dialog-title><media-alert-dialog-description class="media-error__description"></media-alert-dialog-description></div><div class="media-error__actions"><media-alert-dialog-close class="media-button media-button--primary"></media-alert-dialog-close></div></div></media-error-dialog><media-controls class="media-surface media-controls media-controls--root"><media-tooltip-group><div class="media-surface media-controls media-controls--primary"><div class="media-button-group"><media-play-button commandfor="play-tooltip" class="media-button media-button--subtle media-button--icon media-button--play"> ${renderIcon("restart", { class: "media-icon media-icon--restart" })} ${renderIcon("play", { class: "media-icon media-icon--play" })} ${renderIcon("pause", { class: "media-icon media-icon--pause" })} </media-play-button><media-tooltip id="play-tooltip" side="top" class="media-surface media-tooltip"><media-tooltip-label></media-tooltip-label><media-tooltip-shortcut class="media-tooltip__kbd"></media-tooltip-shortcut></media-tooltip><media-mute-button commandfor="video-volume-popover" class="media-button media-button--subtle media-button--icon media-button--mute"> ${renderIcon("volume-off", { class: "media-icon media-icon--volume-off" })} ${renderIcon("volume-low", { class: "media-icon media-icon--volume-low" })} ${renderIcon("volume-high", { class: "media-icon media-icon--volume-high" })} </media-mute-button><media-popover id="video-volume-popover" open-on-hover delay="200" close-delay="100" side="top" class="media-surface media-popover media-popover--volume"><media-volume-slider class="media-slider" orientation="vertical" thumb-alignment="edge"><media-slider-track class="media-slider__track"><media-slider-fill class="media-slider__fill"></media-slider-fill></media-slider-track><media-slider-thumb class="media-slider__thumb media-slider__thumb--persistent"></media-slider-thumb></media-volume-slider></media-popover></div><div class="media-time-controls"><media-time type="current" class="media-time"></media-time><media-time-slider class="media-slider"><media-time-slider-chapters class="media-slider__chapters"><template><div class="media-slider__chapter"><media-slider-track class="media-slider__track media-slider__chapter-track"><media-slider-buffer class="media-slider__buffer"></media-slider-buffer><media-slider-fill class="media-slider__fill"></media-slider-fill></media-slider-track></div></template></media-time-slider-chapters><media-slider-thumb class="media-slider__thumb"></media-slider-thumb><media-slider-preview overflow="visible" class="media-slider__preview"><div class="media-surface media-thumbnail media-slider__thumbnail"><media-slider-thumbnail class="media-thumbnail__image"></media-slider-thumbnail> ${renderIcon("spinner", { class: "media-thumbnail__spinner media-icon" })} </div><div class="media-slider__value"><media-time-slider-chapter-title class="media-slider__chapter-title"></media-time-slider-chapter-title><media-slider-value type="pointer" class="media-time"></media-slider-value></div></media-slider-preview></media-time-slider><media-time toggle type="remaining" class="media-time"></media-time></div><div class="media-button-group"><media-captions-button commandfor="captions-tooltip" class="media-button media-button--subtle media-button--icon media-button--captions"> ${renderIcon("captions-off", { class: "media-icon media-icon--captions-off" })} ${renderIcon("captions-on", { class: "media-icon media-icon--captions-on" })} </media-captions-button><media-tooltip id="captions-tooltip" side="top" class="media-surface media-tooltip"><media-tooltip-label></media-tooltip-label><media-tooltip-shortcut class="media-tooltip__kbd"></media-tooltip-shortcut></media-tooltip><button id="settings-trigger" commandfor="settings-menu" aria-labelledby="settings-label" class="media-button media-button--subtle media-button--icon media-button--settings"> ${renderIcon("gear", { class: "media-icon media-icon--settings" })} ${renderText(settingsText, {
		id: "settings-label",
		class: "media-sr-only"
	})} </button><media-menu id="settings-menu" side="top" align="center" class="media-surface media-popover media-menu media-menu--settings"><div class="media-menu__group"><media-menu-item commandfor="settings-quality-menu" class="media-menu__item media-menu__item--submenu"> ${renderIcon("switches", { class: "media-icon" })} ${renderText(qualityText)} <span class="media-menu__hint"><span data-part="hint" class="media-menu__hint-label"></span> ${renderIcon("chevron", { class: "media-icon media-menu__chevron" })} </span></media-menu-item><media-menu-item commandfor="settings-audio-menu" class="media-menu__item media-menu__item--submenu"> ${renderIcon("speech", { class: "media-icon" })} ${renderText(audioText)} <span class="media-menu__hint"><span data-part="hint" class="media-menu__hint-label"></span> ${renderIcon("chevron", { class: "media-icon media-menu__chevron" })} </span></media-menu-item><media-menu-item commandfor="settings-speed-menu" class="media-menu__item media-menu__item--submenu"> ${renderIcon("speed", { class: "media-icon" })} ${renderText(speedText)} <span class="media-menu__hint"><span data-part="hint" class="media-menu__hint-label"></span> ${renderIcon("chevron", { class: "media-icon media-menu__chevron" })} </span></media-menu-item><media-menu-item commandfor="settings-captions-menu" class="media-menu__item media-menu__item--submenu"> ${renderIcon("captions-off", { class: "media-icon" })} ${renderText(captionsText)} <span class="media-menu__hint"><span data-part="hint" class="media-menu__hint-label"></span> ${renderIcon("chevron", { class: "media-icon media-menu__chevron" })} </span></media-menu-item></div><media-menu id="settings-quality-menu" class="media-menu__panel"><media-menu-item class="media-menu__back"> ${renderIcon("chevron", { class: "media-icon media-menu__chevron media-icon--flipped" })} ${renderText(qualityText)} </media-menu-item><div class="media-menu__separator"></div><media-quality-radio-group class="media-menu__group"><template><media-menu-radio-item class="media-menu__item"><span><span data-part="label"></span><sup data-part="tier" class="media-menu__tier"></sup></span><span data-part="badge" class="media-badge"></span><media-menu-item-indicator force-mount class="media-menu__indicator"> ${renderIcon("check", { class: "media-icon" })} </media-menu-item-indicator></media-menu-radio-item></template></media-quality-radio-group></media-menu><media-menu id="settings-audio-menu" class="media-menu__panel"><media-menu-item class="media-menu__back"> ${renderIcon("chevron", { class: "media-icon media-menu__chevron media-icon--flipped" })} ${renderText(audioText)} </media-menu-item><div class="media-menu__separator"></div><media-audio-track-radio-group class="media-menu__group"><template><media-menu-radio-item class="media-menu__item"><span data-part="label"></span><media-menu-item-indicator force-mount class="media-menu__indicator"> ${renderIcon("check", { class: "media-icon" })} </media-menu-item-indicator></media-menu-radio-item></template></media-audio-track-radio-group></media-menu><media-menu id="settings-speed-menu" class="media-menu__panel"><media-menu-item class="media-menu__back"> ${renderIcon("chevron", { class: "media-icon media-menu__chevron media-icon--flipped" })} ${renderText(speedText)} </media-menu-item><div class="media-menu__separator"></div><media-playback-rate-radio-group class="media-menu__group"><template><media-menu-radio-item class="media-menu__item"><span data-part="label"></span><media-menu-item-indicator force-mount class="media-menu__indicator"> ${renderIcon("check", { class: "media-icon" })} </media-menu-item-indicator></media-menu-radio-item></template></media-playback-rate-radio-group></media-menu><media-menu id="settings-captions-menu" class="media-menu__panel"><media-menu-item class="media-menu__back"> ${renderIcon("chevron", { class: "media-icon media-menu__chevron media-icon--flipped" })} ${renderText(captionsText)} </media-menu-item><div class="media-menu__separator"></div><media-captions-radio-group class="media-menu__group"><template><media-menu-radio-item class="media-menu__item"><span data-part="label"></span><media-menu-item-indicator force-mount class="media-menu__indicator"> ${renderIcon("check", { class: "media-icon" })} </media-menu-item-indicator></media-menu-radio-item></template></media-captions-radio-group></media-menu></media-menu><media-tooltip id="settings-tooltip" trigger="settings-trigger" side="top" class="media-surface media-tooltip"> ${renderText(settingsText)} </media-tooltip></div></div><div class="media-surface media-controls media-controls--secondary"><div class="media-button-group"><media-cast-button commandfor="cast-tooltip" class="media-button media-button--subtle media-button--icon media-button--cast"> ${renderIcon("cast-enter", { class: "media-icon media-icon--cast-enter" })} ${renderIcon("cast-exit", { class: "media-icon media-icon--cast-exit" })} </media-cast-button><media-tooltip id="cast-tooltip" side="top" class="media-surface media-tooltip"><media-tooltip-label></media-tooltip-label><media-tooltip-shortcut class="media-tooltip__kbd"></media-tooltip-shortcut></media-tooltip><media-airplay-button commandfor="airplay-tooltip" class="media-button media-button--subtle media-button--icon media-button--airplay"> ${renderIcon("airplay-enter", { class: "media-icon media-icon--airplay-enter" })} ${renderIcon("airplay-exit", { class: "media-icon media-icon--airplay-exit" })} </media-airplay-button><media-tooltip id="airplay-tooltip" side="top" class="media-surface media-tooltip"><media-tooltip-label></media-tooltip-label><media-tooltip-shortcut class="media-tooltip__kbd"></media-tooltip-shortcut></media-tooltip><media-pip-button commandfor="pip-tooltip" class="media-button media-button--subtle media-button--icon media-button--pip"> ${renderIcon("pip-enter", { class: "media-icon media-icon--pip-enter" })} ${renderIcon("pip-exit", { class: "media-icon media-icon--pip-exit" })} </media-pip-button><media-tooltip id="pip-tooltip" side="top" class="media-surface media-tooltip"><media-tooltip-label></media-tooltip-label><media-tooltip-shortcut class="media-tooltip__kbd"></media-tooltip-shortcut></media-tooltip><media-fullscreen-button commandfor="fullscreen-tooltip" class="media-button media-button--subtle media-button--icon media-button--fullscreen"> ${renderIcon("fullscreen-enter", { class: "media-icon media-icon--fullscreen-enter" })} ${renderIcon("fullscreen-exit", { class: "media-icon media-icon--fullscreen-exit" })} </media-fullscreen-button><media-tooltip id="fullscreen-tooltip" side="top" class="media-surface media-tooltip"><media-tooltip-label></media-tooltip-label><media-tooltip-shortcut class="media-tooltip__kbd"></media-tooltip-shortcut></media-tooltip></div></div></media-tooltip-group></media-controls><div class="media-overlay"></div><media-hotkey keys="Space" action="togglePaused"></media-hotkey><media-hotkey keys="k" action="togglePaused"></media-hotkey><media-hotkey keys="m" action="toggleMuted"></media-hotkey><media-hotkey keys="f" action="toggleFullscreen"></media-hotkey><media-hotkey keys="c" action="toggleSubtitles"></media-hotkey><media-hotkey keys="i" action="togglePictureInPicture"></media-hotkey><media-hotkey keys="ArrowRight" action="seekStep" value="5"></media-hotkey><media-hotkey keys="ArrowLeft" action="seekStep" value="-5"></media-hotkey><media-hotkey keys="l" action="seekStep" value="10"></media-hotkey><media-hotkey keys="j" action="seekStep" value="-10"></media-hotkey><media-hotkey keys="ArrowUp" action="volumeStep" value="0.05"></media-hotkey><media-hotkey keys="ArrowDown" action="volumeStep" value="-0.05"></media-hotkey><media-hotkey keys="0-9" action="seekToPercent"></media-hotkey><media-hotkey keys="Home" action="seekToPercent" value="0"></media-hotkey><media-hotkey keys="End" action="seekToPercent" value="100"></media-hotkey><media-hotkey keys=">" action="speedUp"></media-hotkey><media-hotkey keys="<" action="speedDown"></media-hotkey><media-gesture type="tap" action="togglePaused" pointer="mouse" region="center"></media-gesture><media-gesture type="tap" action="toggleControls" pointer="touch"></media-gesture><media-gesture type="doubletap" action="seekStep" value="-10" region="left"></media-gesture><media-gesture type="doubletap" action="toggleFullscreen" region="center"></media-gesture><media-gesture type="doubletap" action="seekStep" value="10" region="right"></media-gesture><media-status-announcer class="media-sr-only"></media-status-announcer><div class="media-input-indicator-overlay"><media-volume-indicator hidden class="media-surface media-volume-indicator"><media-volume-indicator-fill class="media-volume-indicator__content"> ${renderIcon("volume-high", { class: "media-icon media-icon--volume-high" })} ${renderIcon("volume-low", { class: "media-icon media-icon--volume-low" })} ${renderIcon("volume-off", { class: "media-icon media-icon--volume-off" })} <media-volume-indicator-value class="media-volume-indicator__value"></media-volume-indicator-value></media-volume-indicator-fill></media-volume-indicator><media-status-indicator hidden actions="toggleSubtitles toggleFullscreen togglePictureInPicture" class="media-surface media-status-indicator media-status-indicator--state" ><div class="media-status-indicator__content"> ${renderIcon("captions-on", { class: "media-icon media-icon--captions-on" })} ${renderIcon("captions-off", { class: "media-icon media-icon--captions-off" })} ${renderIcon("fullscreen-enter", { class: "media-icon media-icon--fullscreen-enter" })} ${renderIcon("fullscreen-exit", { class: "media-icon media-icon--fullscreen-exit" })} ${renderIcon("pip-enter", { class: "media-icon media-icon--pip-enter" })} ${renderIcon("pip-exit", { class: "media-icon media-icon--pip-exit" })} <media-status-indicator-value class="media-status-indicator__value"></media-status-indicator-value></div></media-status-indicator><media-seek-indicator hidden class="media-seek-indicator"> ${renderIcon("chevron", { class: "media-icon media-icon--seek" })} <media-seek-indicator-value class="media-seek-indicator__value"></media-seek-indicator-value></media-seek-indicator><media-status-indicator hidden actions="togglePaused" class="media-status-indicator media-status-indicator--playback"> ${renderIcon("play", { class: "media-icon media-icon--play" })} ${renderIcon("pause", { class: "media-icon media-icon--pause" })} </media-status-indicator></div></media-container>`;
}
var VideoSkinElement = class extends SkinElement {
	static {
		this.tagName = "video-skin";
	}
	static {
		this.styles = createShadowStyle(skin_default);
	}
	static {
		this.template = createTemplate(getTemplateHTML());
	}
};
safeDefine(VideoSkinElement);

//#endregion
//#region ../html/dist/default/define/ui/poster.js
safeDefine(PosterElement);

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
const DEFAULT_LABELS = {
	skip: "Skip ad",
	skipCountdown: (seconds) => `Skip in ${seconds}s`,
	timer: (elapsed, duration) => `AD ${elapsed} / ${duration}`,
	mediaAlt: "Advertisement"
};
var AdsOverlay = class {
	#root;
	#timer;
	#skip;
	#mediaContainer;
	#adMedia = null;
	#onSkip = null;
	#destroyed = false;
	#labels;
	constructor(container, options = {}) {
		injectStyles();
		this.#labels = {
			...DEFAULT_LABELS,
			...options.labels
		};
		this.#root = document.createElement("div");
		this.#root.className = "vjs-ads-overlay";
		this.#root.dataset.adPhase = "hidden";
		this.#mediaContainer = document.createElement("div");
		this.#mediaContainer.style.cssText = "width:100%;height:100%;display:flex;align-items:center;justify-content:center;";
		this.#timer = document.createElement("div");
		this.#timer.className = "vjs-ads-timer";
		this.#timer.textContent = this.#labels.timer(formatTime(0), formatTime(0));
		this.#skip = document.createElement("button");
		this.#skip.className = "vjs-ads-skip";
		this.#skip.type = "button";
		this.#skip.dataset.skipAvailable = "false";
		this.#skip.textContent = this.#labels.skip;
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
			img.alt = this.#labels.mediaAlt;
			if (onClick) img.addEventListener("click", onClick);
			this.#mediaContainer.appendChild(img);
			this.#adMedia = img;
		}
		this.#root.dataset.adPhase = "playing";
	}
	updateTimer(currentTime, duration) {
		this.#timer.textContent = this.#labels.timer(formatTime(currentTime), formatTime(duration));
	}
	updateSkip(available, countdown) {
		this.#skip.dataset.skipAvailable = String(available);
		this.#skip.textContent = available ? this.#labels.skip : this.#labels.skipCountdown(countdown);
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
export { AdsOverlay, fetchAds, trackAdEvent };
//# sourceMappingURL=video-ads.dev.js.map