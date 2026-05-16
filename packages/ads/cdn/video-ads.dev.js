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
const cache = /* @__PURE__ */ new WeakMap();
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
	#controllers = /* @__PURE__ */ new Set();
	#changedProperties = /* @__PURE__ */ new Map();
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
	const existing = cache.get(ctor);
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
	cache.set(ctor, meta);
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

//#endregion
//#region ../html/dist/default/media/container-element.js
const ContainerMixin = createContainerMixin({
	playerContext,
	containerContext
});
var MediaContainerElement = class extends ContainerMixin(MediaElement) {
	static {
		this.tagName = "media-container";
	}
};

//#endregion
//#region ../utils/dist/predicate/predicate.js
function isNumber(value) {
	return typeof value === "number";
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
* @param config - Provider configuration with contexts and store factory.
*/
function createProviderMixin(config) {
	return (BaseClass) => {
		class PlayerProviderElement extends BaseClass {
			#store = config.factory();
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
				context: config.playerContext,
				initialValue: this.store
			});
			#mediaProvider = new i(this, {
				context: config.mediaContext,
				initialValue: {
					media: this.#media,
					setMedia: this.#setMedia
				}
			});
			#containerProvider = new i(this, {
				context: config.containerContext,
				initialValue: {
					container: this.#container,
					setContainer: this.#setContainer
				}
			});
			get store() {
				if (isNull(this.#store)) this.#store = config.factory();
				return this.#store;
			}
			connectedCallback() {
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
//#region ../store/dist/default/core/shallow-equal.js
const hasOwn = Object.prototype.hasOwnProperty;
function shallowEqual(a, b) {
	if (Object.is(a, b)) return true;
	if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return false;
	const keysA = Object.keys(a);
	const keysB = Object.keys(b);
	if (keysA.length !== keysB.length) return false;
	for (const key of keysA) if (!hasOwn.call(b, key) || !Object.is(a[key], b[key])) return false;
	return true;
}

//#endregion
//#region ../utils/dist/function/noop.js
function noop(..._args) {}

//#endregion
//#region ../utils/dist/function/throttle.js
/**
* Trailing-edge throttle: the first call schedules a timer; subsequent calls
* within the window update the arguments. The function fires once per `ms`
* window with the latest arguments.
*/
function throttle(fn, ms) {
	let timerId = null;
	let latestArgs;
	const throttled = (...args) => {
		latestArgs = args;
		if (timerId !== null) return;
		timerId = setTimeout(() => {
			timerId = null;
			fn(...latestArgs);
		}, ms);
	};
	throttled.cancel = () => {
		if (timerId !== null) {
			clearTimeout(timerId);
			timerId = null;
		}
	};
	return throttled;
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
//#region ../store/dist/default/core/abort-controller-registry.js
var AbortControllerRegistry = class {
	#base = new AbortController();
	#keys = /* @__PURE__ */ new Map();
	/** The attach-scoped signal. Aborts on detach or reattach. */
	get base() {
		return this.#base.signal;
	}
	/** Clears all keyed signals, leaving base intact. */
	clear() {
		for (const controller of this.#keys.values()) controller.abort();
		this.#keys.clear();
	}
	/** Resets base and clears all keyed signals. */
	reset() {
		this.clear();
		this.#base.abort();
		this.#base = new AbortController();
	}
	/** Creates a new signal for the key, superseding any previous signal. */
	supersede(key) {
		this.#keys.get(key)?.abort();
		const controller = new AbortController();
		this.#keys.set(key, controller);
		return AbortSignal.any([this.#base.signal, controller.signal]);
	}
};

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
//#region ../store/dist/default/core/state.js
let isFlushScheduled = false;
function scheduleFlush() {
	if (isFlushScheduled) return;
	isFlushScheduled = true;
	queueMicrotask(flush);
}
const pendingContainers = /* @__PURE__ */ new Set();
function flush() {
	isFlushScheduled = false;
	for (const container of pendingContainers) container.flush();
	pendingContainers.clear();
}
const hasOwnProp = Object.prototype.hasOwnProperty;
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
		for (const key in partial) {
			if (!hasOwnProp.call(partial, key)) continue;
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
const STORE_SYMBOL = Symbol("@videojs/store");
function createStore() {
	return (slice, options = {}) => {
		let target = null;
		let destroyed = false;
		const setupAbort = new AbortController();
		const signals = new AbortControllerRegistry();
		let state;
		function validate() {
			if (destroyed) throwDestroyedError();
			if (!target) throwNoTargetError();
		}
		const initialState = slice.state({
			target: () => {
				validate();
				return target;
			},
			signals,
			set: (partial) => state.patch(partial)
		});
		state = createState(initialState);
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
		for (const key of Object.keys(initialState)) Object.defineProperty(store, key, {
			get: () => state.current[key],
			enumerable: true
		});
		try {
			options.onSetup?.({
				store,
				signal: setupAbort.signal
			});
		} catch (error) {
			reportError(error);
		}
		return store;
		function attach(newTarget) {
			if (destroyed) throwDestroyedError();
			signals.reset();
			target = newTarget;
			const attachContext = {
				target: newTarget,
				signal: signals.base,
				get: () => state.current,
				set: (partial) => state.patch(partial),
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
			state.patch(initialState);
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
	};
}
function isStore(value) {
	return isObject(value) && STORE_SYMBOL in value;
}

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
//#region ../store/dist/default/core/combine.js
/**
* Combines multiple slices into a single slice.
*
* @param slices - The slices to combine.
* @returns A new slice that represents the combination of the input slices.
*/
function combine(...slices) {
	return {
		state: (ctx) => {
			const states = slices.map((slice) => slice.state(ctx));
			return Object.assign({}, ...states);
		},
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
//#region ../utils/dist/object/defaults.js
/**
* Creates a new object with default values filled in for undefined properties.
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
	for (const key in object) if (!isUndefined(object[key])) result[key] = object[key];
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
	for (const key of keys) result[key] = obj[key];
	return result;
}

//#endregion
//#region ../store/dist/default/core/selector.js
const stateContext = {
	target: throwNoTargetError,
	signals: new AbortControllerRegistry(),
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
	const keys = Object.keys(initialState);
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
	return (config) => config;
}

//#endregion
//#region ../html/dist/default/player/create-player.js
function createPlayer(config) {
	const slice = combine(...config.features);
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
			factory: create
		}),
		ContainerMixin: createContainerMixin({
			playerContext,
			containerContext
		})
	};
}

//#endregion
//#region ../html/dist/default/define/safe-define.js
/** Define a custom element only if not already registered. */
function safeDefine(element) {
	if (!customElements.get(element.tagName)) customElements.define(element.tagName, element);
}

//#endregion
//#region ../core/dist/default/dom/feature.js
const definePlayerFeature = defineSlice();

//#endregion
//#region ../core/dist/default/core/utils/define-class-prop-hooks.js
function defineClassPropHooks(Class, BaseClassProto) {
	for (const prop of Object.getOwnPropertyNames(BaseClassProto)) {
		if (prop in Class.prototype) continue;
		const descriptor = Object.getOwnPropertyDescriptor(BaseClassProto, prop);
		if (!descriptor) continue;
		const config = {};
		if (typeof descriptor.value === "function") config.value = function(...args) {
			return this.call?.(prop, ...args);
		};
		else if (descriptor.get) {
			config.get = function() {
				return this.get?.(prop);
			};
			if (descriptor.set) config.set = function(val) {
				this.set?.(prop, val);
			};
		}
		Object.defineProperty(Class.prototype, prop, config);
	}
}

//#endregion
//#region ../core/dist/default/core/media/proxy.js
/**
* This mixin creates an API from the passed classes and proxies the methods and properties to the attached target.
*
* Many methods and properties will need no translation and are proxied directly to the attached target.
* For example, the `play` and `pause` methods are proxied directly to the attached target.
*
* Child classes can override the proxied methods and properties to provide custom behavior.
* For example, the `src` property for HLS media is proxied to the HLS engine, not the target itself.
*
* The `get`, `set`, and `call` methods can be overridden to provide catch-all custom behavior.
*/
const ProxyMixin = (PrimaryClass, ...AdditionalClasses) => {
	class MediaProxy {
		#target = null;
		get target() {
			return this.#target;
		}
		get(prop) {
			return this.target?.[prop];
		}
		set(prop, val) {
			if (this.target) this.target[prop] = val;
		}
		call(prop, ...args) {
			return (this.target?.[prop])?.apply(this.target, args);
		}
		attach(target) {
			if (!target || this.#target === target) return;
			this.#target = target;
		}
		detach() {
			if (!this.#target) return;
			this.#target = null;
		}
	}
	for (const Class of [PrimaryClass, ...AdditionalClasses]) defineClassPropHooks(MediaProxy, Class.prototype);
	return MediaProxy;
};

//#endregion
//#region ../core/dist/default/dom/media/proxy.js
const VideoProxy = ProxyMixin(globalThis.HTMLVideoElement ?? class {}, globalThis.HTMLMediaElement ?? class {}, globalThis.EventTarget ?? class {});

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
//#region ../utils/dist/dom/supports.js
function supportsAnchorPositioning() {
	return typeof CSS !== "undefined" && CSS.supports("anchor-name: --a");
}

//#endregion
//#region ../utils/dist/dom/listen.js
function listen(target, type, listener, options) {
	target.addEventListener(type, listener, options);
	return () => target.removeEventListener(type, listener, options);
}

//#endregion
//#region ../utils/dist/dom/popover.js
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
//#region ../utils/dist/string/casing.js
function kebabCase(str) {
	return str.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

//#endregion
//#region ../utils/dist/dom/style.js
function applyStyles(element, styles) {
	for (const [prop, value] of Object.entries(styles)) if (typeof value === "string") {
		const key = prop.startsWith("--") ? prop : kebabCase(prop);
		element.style.setProperty(key, value);
	}
}
function resolveCSSLength(el, value) {
	const trimmed = value.trim();
	if (!trimmed) return 0;
	const parsed = Number.parseFloat(trimmed);
	if (Number.isNaN(parsed)) return 0;
	if (/^-?\d*\.?\d+$/.test(trimmed) || trimmed.endsWith("px")) return parsed;
	const doc = el.ownerDocument;
	const root = doc?.documentElement;
	if (trimmed.endsWith("rem")) return parsed * (root ? Number.parseFloat(getComputedStyle(root).fontSize) || 16 : 16);
	if (trimmed.endsWith("em")) return parsed * (el instanceof HTMLElement ? Number.parseFloat(getComputedStyle(el).fontSize) || 16 : 16);
	if (!doc) return parsed;
	const measurementEl = doc.createElement("div");
	measurementEl.style.position = "absolute";
	measurementEl.style.visibility = "hidden";
	measurementEl.style.pointerEvents = "none";
	measurementEl.style.inlineSize = trimmed;
	measurementEl.style.blockSize = "0";
	measurementEl.style.padding = "0";
	measurementEl.style.border = "0";
	measurementEl.style.inset = "0";
	const parent = doc.body ?? doc.documentElement;
	if (!parent) return parsed;
	parent.appendChild(measurementEl);
	const pixels = measurementEl.getBoundingClientRect().width;
	measurementEl.remove();
	return Number.isFinite(pixels) ? pixels : parsed;
}

//#endregion
//#region ../utils/dist/dom/text-track.js
/** Find the `<track>` element that owns the given `TextTrack`. */
function findTrackElement(media, track) {
	for (const el of media.querySelectorAll?.("track") ?? []) if (el.track === track) return el;
	return null;
}
function getTextTrackList(media, filterPred) {
	if (!media?.textTracks) return [];
	return Array.from(media.textTracks).filter(filterPred).sort(sortByTextTrackKind);
}
function sortByTextTrackKind(a, b) {
	return a.kind >= b.kind ? 1 : -1;
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
//#region ../core/dist/default/dom/store/features/buffer.js
const bufferFeature = definePlayerFeature({
	name: "buffer",
	state: () => ({
		buffered: [],
		seekable: []
	}),
	attach({ target, signal, set }) {
		const { media } = target;
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
//#region ../core/dist/default/dom/store/features/controls.js
const IDLE_DELAY = 2e3;
const TAP_THRESHOLD = 250;
const controlsFeature = definePlayerFeature({
	name: "controls",
	state: () => ({
		userActive: true,
		controlsVisible: true
	}),
	attach({ target, signal, get, set }) {
		const { media, container } = target;
		if (isNull(container)) return;
		function computeVisible(userActive) {
			return userActive || media.paused;
		}
		let idleTimer;
		function clearIdle() {
			clearTimeout(idleTimer);
			idleTimer = void 0;
		}
		function scheduleIdle() {
			clearIdle();
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
		let pointerDownTime = 0;
		function onPointerDown() {
			pointerDownTime = Date.now();
		}
		function onPointerUp(event) {
			if (event.pointerType === "touch" && Date.now() - pointerDownTime < TAP_THRESHOLD) {
				const isMediaOrContainer = [media, container].includes(event.target);
				if (get().controlsVisible && isMediaOrContainer) setInactive();
				else setActive();
			} else setActive();
		}
		function onPlaybackChange() {
			const { userActive } = get();
			set({ controlsVisible: computeVisible(userActive) });
			if (!media.paused && userActive) scheduleIdle();
		}
		listen(container, "pointermove", setActive, { signal });
		listen(container, "pointerdown", onPointerDown, { signal });
		listen(container, "pointerup", onPointerUp, { signal });
		listen(container, "keyup", setActive, { signal });
		listen(container, "focusin", setActive, { signal });
		listen(container, "mouseleave", setInactive, { signal });
		listen(media, "play", onPlaybackChange, { signal });
		listen(media, "pause", onPlaybackChange, { signal });
		listen(media, "ended", onPlaybackChange, { signal });
		signal.addEventListener("abort", clearIdle, { once: true });
		scheduleIdle();
	}
});

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
		const syncError = () => set({ error: media.error });
		listen(media, "error", syncError, { signal });
		listen(media, "emptied", () => set({ error: null }), { signal });
	}
});

//#endregion
//#region ../core/dist/default/dom/presentation/fullscreen.js
/** Check if the Fullscreen API is supported on this platform. */
function isFullscreenEnabled() {
	const doc = document;
	if (doc.fullscreenEnabled || doc.webkitFullscreenEnabled) return true;
	return isFunction(document.createElement("video").webkitEnterFullscreen);
}
/** Get the current fullscreen element from the document. */
function getFullscreenElement() {
	const doc = document;
	return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}
/**
* Check if a specific element (or its media) is currently in fullscreen.
*
* Uses `:fullscreen` pseudo-class which works across Shadow DOM boundaries.
*/
function isFullscreenElement(container, media) {
	const video = media;
	if (video.webkitDisplayingFullscreen && video.webkitPresentationMode === "fullscreen") return true;
	const target = container ?? media;
	if (getFullscreenElement() === target) return true;
	try {
		return target.matches(":fullscreen");
	} catch {
		return false;
	}
}
/**
* Request fullscreen mode.
*
* Tries container first (to show custom UI), falls back to media element
* for platforms that only support video fullscreen (iOS Safari).
*/
async function requestFullscreen(container, media) {
	const doc = document;
	const video = media;
	if (container && (doc.fullscreenEnabled || doc.webkitFullscreenEnabled)) {
		const el = container;
		if (isFunction(el.requestFullscreen)) return el.requestFullscreen();
		if (isFunction(el.webkitRequestFullscreen)) return el.webkitRequestFullscreen();
	}
	if (isFunction(video.webkitEnterFullscreen)) {
		video.webkitEnterFullscreen();
		return;
	}
	if (isFunction(media.requestFullscreen)) return media.requestFullscreen();
	throw new DOMException("Fullscreen not supported", "NotSupportedError");
}
/** Exit fullscreen mode. */
async function exitFullscreen(media) {
	const doc = document;
	if (media) {
		const video = media;
		if (isFunction(video.webkitExitFullscreen) && video.webkitDisplayingFullscreen) {
			video.webkitExitFullscreen();
			return;
		}
	}
	if (isFunction(doc.exitFullscreen)) return doc.exitFullscreen();
	if (isFunction(doc.webkitExitFullscreen)) return doc.webkitExitFullscreen();
}

//#endregion
//#region ../core/dist/default/dom/presentation/pip.js
function resolveMediaTarget(media) {
	const target = media.target;
	return target instanceof HTMLMediaElement ? target : media;
}
/**
* Check if Picture-in-Picture is supported on this platform.
*
* Note: Safari PWAs don't support PiP even though the API exists.
*/
function isPictureInPictureEnabled() {
	if (document.pictureInPictureEnabled) {
		const isSafari = /.*Version\/.*Safari\/.*/.test(navigator.userAgent);
		const isPWA = typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches;
		return !isSafari || !isPWA;
	}
	return isFunction(document.createElement("video").webkitSetPresentationMode);
}
/**
* Check if Picture-in-Picture is currently active for a media element.
*/
function isPictureInPictureElement(media) {
	const target = resolveMediaTarget(media);
	if (document.pictureInPictureElement === target) return true;
	return target.webkitPresentationMode === "picture-in-picture";
}
/**
* Request Picture-in-Picture mode.
*
* Uses standard API where available, falls back to iOS Safari's
* WebKit presentation mode.
*/
async function requestPictureInPicture(media) {
	const video = resolveMediaTarget(media);
	if (isFunction(video.webkitSetPresentationMode)) {
		video.webkitSetPresentationMode("picture-in-picture");
		return;
	}
	if (isFunction(video.requestPictureInPicture)) {
		await video.requestPictureInPicture();
		return;
	}
	throw new DOMException("Picture-in-Picture not supported", "NotSupportedError");
}
/**
* Exit Picture-in-Picture mode.
*
* Uses standard API where available, falls back to iOS Safari's
* WebKit presentation mode.
*/
async function exitPictureInPicture(media) {
	if (media) {
		const video = resolveMediaTarget(media);
		if (isFunction(video.webkitSetPresentationMode) && video.webkitPresentationMode === "picture-in-picture") {
			video.webkitSetPresentationMode("inline");
			return;
		}
	}
	if (isFunction(document.exitPictureInPicture)) return document.exitPictureInPicture();
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
			if (isPictureInPictureElement(media)) await exitPictureInPicture(media);
			return requestFullscreen(container, media);
		},
		async exitFullscreen() {
			const { media } = target();
			return exitFullscreen(media);
		}
	}),
	attach({ target, signal, set }) {
		const { media, container } = target;
		set({ fullscreenAvailability: isFullscreenEnabled() ? "available" : "unsupported" });
		const sync = () => set({ fullscreen: isFullscreenElement(container, media) });
		sync();
		listen(document, "fullscreenchange", sync, { signal });
		listen(document, "webkitfullscreenchange", sync, { signal });
		if ("webkitPresentationMode" in media) listen(media, "webkitpresentationmodechanged", sync, { signal });
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
			if (isFullscreenElement(container, media)) await exitFullscreen();
			return requestPictureInPicture(media);
		},
		async exitPictureInPicture() {
			const { media } = target();
			return exitPictureInPicture(media);
		}
	}),
	attach({ target, signal, set }) {
		const { media } = target;
		set({ pipAvailability: isPictureInPictureEnabled() ? "available" : "unsupported" });
		const sync = () => set({ pip: isPictureInPictureElement(media) });
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
			target().media.pause();
		}
	}),
	attach({ target, signal, set }) {
		const { media } = target;
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
			target().media.playbackRate = rate;
		}
	}),
	attach({ target, signal, set }) {
		const { media } = target;
		const sync = () => set({ playbackRate: media.playbackRate });
		sync();
		listen(media, "ratechange", sync, { signal });
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
			media.src = src;
			media.load();
			return src;
		}
	}),
	attach({ target, signal, set }) {
		const { media } = target;
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
//#region ../core/dist/default/dom/store/features/text-track.js
const textTrackFeature = definePlayerFeature({
	name: "textTrack",
	state: ({ target }) => ({
		chaptersCues: [],
		thumbnailCues: [],
		thumbnailTrackSrc: null,
		textTrackList: [],
		subtitlesShowing: false,
		toggleSubtitles(forceShow) {
			const subtitlesTracks = getTextTrackList(target().media, (track) => track.kind === "subtitles" || track.kind === "captions");
			if (!subtitlesTracks.length) return false;
			const showing = subtitlesTracks.some((track) => track.mode === "showing");
			const nextShowing = forceShow ?? !showing;
			for (const track of subtitlesTracks) track.mode = nextShowing ? "showing" : "disabled";
			return nextShowing;
		}
	}),
	attach({ target, signal, set }) {
		const { media } = target;
		let trackCleanup = null;
		function sync() {
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
					kind: track.kind,
					label: track.label,
					language: track.language,
					mode: track.mode
				});
				if ((track.kind === "captions" || track.kind === "subtitles") && track.mode === "showing") subtitlesShowing = true;
			}
			const chaptersCues = chaptersTrack?.cues ? Array.from(chaptersTrack.cues) : [];
			const thumbnailCues = thumbnailTrack?.cues ? Array.from(thumbnailTrack.cues) : [];
			let thumbnailTrackSrc = null;
			if (thumbnailTrack) thumbnailTrackSrc = findTrackElement(media, thumbnailTrack)?.src ?? null;
			for (const trackEl of media.querySelectorAll?.("track") ?? []) if (!trackEl.track?.cues?.length) listen(trackEl, "load", sync, { signal: trackCleanup.signal });
			set({
				chaptersCues,
				thumbnailCues,
				thumbnailTrackSrc,
				textTrackList,
				subtitlesShowing
			});
		}
		sync();
		listen(media.textTracks, "addtrack", sync, { signal });
		listen(media.textTracks, "removetrack", sync, { signal });
		listen(media.textTracks, "change", sync, { signal });
		listen(media, "loadstart", sync, { signal });
		signal.addEventListener("abort", () => trackCleanup?.abort(), { once: true });
	}
});

//#endregion
//#region ../core/dist/default/dom/media/predicate.js
function hasMetadata(media) {
	return media.readyState >= HTMLMediaElement.HAVE_METADATA;
}

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
	attach({ target, signal, set }) {
		const { media } = target;
		const sync = () => set({
			currentTime: media.currentTime,
			duration: Number.isFinite(media.duration) ? media.duration : 0,
			seeking: media.seeking
		});
		sync();
		listen(media, "timeupdate", sync, { signal });
		listen(media, "durationchange", sync, { signal });
		listen(media, "seeking", sync, { signal });
		listen(media, "seeked", sync, { signal });
		listen(media, "loadedmetadata", sync, { signal });
		listen(media, "emptied", sync, { signal });
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
		setVolume(volume) {
			const { media } = target();
			const clamped = Math.max(0, Math.min(1, volume));
			if (clamped > 0 && media.muted) media.muted = false;
			media.volume = clamped;
			return media.volume;
		},
		toggleMuted() {
			const { media } = target();
			if (media.muted || media.volume === 0) {
				media.muted = false;
				if (media.volume === 0) media.volume = UNMUTE_VOLUME;
			} else media.muted = true;
			return media.muted;
		}
	}),
	attach({ target, signal, set }) {
		const { media } = target;
		set({ volumeAvailability: canSetVolume() });
		const sync = () => set({
			volume: media.volume,
			muted: media.muted
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
//#region ../core/dist/default/dom/store/features/presets.js
const videoFeatures = [
	playbackFeature,
	playbackRateFeature,
	volumeFeature,
	timeFeature,
	sourceFeature,
	bufferFeature,
	fullscreenFeature,
	pipFeature,
	controlsFeature,
	textTrackFeature,
	errorFeature
];

//#endregion
//#region ../core/dist/default/dom/store/selectors.js
/** Select the buffer state (buffered ranges, percent buffered). */
const selectBuffer = createSelector(bufferFeature);
/** Select the controls state (controls visible, user-active). */
const selectControls = createSelector(controlsFeature);
/** Select the error state (error, dismissed, dismissError). */
const selectError = createSelector(errorFeature);
/** Select the fullscreen state (fullscreen active, availability). */
const selectFullscreen = createSelector(fullscreenFeature);
/** Select the PiP state (picture-in-picture active, availability). */
const selectPiP = createSelector(pipFeature);
/** Select the playback state (paused, ended, play, pause, toggle). */
const selectPlayback = createSelector(playbackFeature);
/** Select the playback rate state (playbackRate, playbackRates, setPlaybackRate). */
const selectPlaybackRate = createSelector(playbackRateFeature);
/** Select the source state (src, type). */
const selectSource = createSelector(sourceFeature);
/** Select the text track state (chapters cues, thumbnail cues). */
const selectTextTrack = createSelector(textTrackFeature);
/** Select the time state (currentTime, duration, seek). */
const selectTime = createSelector(timeFeature);
/** Select the volume state (volume, muted, setVolume, setMuted). */
const selectVolume = createSelector(volumeFeature);

//#endregion
//#region ../core/dist/default/dom/ui/dismiss-layer.js
function createDismissLayer(options) {
	const { transition } = options;
	const state = transition.state;
	const abort = new AbortController();
	let docAbort = null;
	function open() {
		if (abort.signal.aborted) return null;
		const { active, status } = state.current;
		if (active && status !== "ending") return null;
		if (status === "ending") transition.cancel();
		return transition.open();
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
			onActivate();
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
				onActivate();
			} else if (event.key === " ") event.preventDefault();
		},
		onKeyUp(event) {
			if (event.target !== event.currentTarget) return;
			if (isDisabled()) return;
			if (event.key === " ") onActivate();
		}
	};
}

//#endregion
//#region ../core/dist/default/dom/ui/popover/popover.js
function createPopover(options) {
	const { onOpenChange, closeOnOutsideClick } = options;
	let triggerEl = null;
	let popupEl = null;
	let hoverTimeout = null;
	const capturedPointers = /* @__PURE__ */ new Set();
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
	/**
	* The transition handler manages animation lifecycle via `createState`:
	*
	* **Open:** `transition.open()` patches `{ active: true, status: 'starting' }`.
	* After one RAF it patches `{ status: 'idle' }` and the promise resolves.
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
	function applyOpen(reason, event) {
		const opening = layer.open();
		if (!opening) return;
		onOpenChange(true, event ? {
			reason,
			event
		} : { reason });
		opening.then(() => {
			if (layer.signal.aborted || !state.current.active) return;
			options.onOpenChangeComplete?.(true);
		});
	}
	function applyClose(reason, event) {
		const closing = layer.close(popupEl);
		if (!closing) return;
		onOpenChange(false, event ? {
			reason,
			event
		} : { reason });
		closing.then(() => {
			if (layer.signal.aborted) return;
			tryHidePopover(popupEl);
			options.onOpenChangeComplete?.(false);
		});
	}
	function open(reason = "click") {
		applyOpen(reason);
	}
	function close(reason = "click") {
		applyClose(reason);
	}
	function handleDocumentPointerdown(event) {
		if (!closeOnOutsideClick() || !state.current.active) return;
		const path = event.composedPath();
		if (triggerEl && path.includes(triggerEl) || popupEl && path.includes(popupEl)) return;
		applyClose("outside-click", event);
	}
	layer.signal.addEventListener("abort", () => {
		clearHoverTimeout();
		capturedPointers.clear();
		triggerEl = null;
		popupEl = null;
	});
	const triggerProps = {
		onClick(event) {
			if (!canToggleOnClick()) return;
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
			applyClose("blur");
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
		destroy: layer.destroy
	};
}

//#endregion
//#region ../core/dist/default/core/ui/popover/popover-css-vars.js
const PopoverCSSVars = {
	sideOffset: "--media-popover-side-offset",
	alignOffset: "--media-popover-align-offset",
	anchorWidth: "--media-popover-anchor-width",
	anchorHeight: "--media-popover-anchor-height",
	availableWidth: "--media-popover-available-width",
	availableHeight: "--media-popover-available-height"
};

//#endregion
//#region ../core/dist/default/dom/ui/popover/popover-positioning.js
const OPPOSITE_SIDE = {
	top: "bottom",
	bottom: "top",
	left: "right",
	right: "left"
};
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
	if (supportsAnchorPositioning()) return getAnchorPositionCSS(anchorName, opts, cssVars);
	if (triggerRect && popupRect) return {
		...getManualPositionStyle(triggerRect, popupRect, opts, offsets ?? {
			sideOffset: 0,
			alignOffset: 0
		}),
		...boundaryRect ? getPositioningCSSVars(triggerRect, boundaryRect, opts.side, cssVars) : {},
		position: "fixed",
		inset: "auto",
		margin: "0"
	};
	return {};
}
/** Generate style to set on the trigger for CSS Anchor Positioning. */
function getAnchorNameStyle(anchorName) {
	if (!supportsAnchorPositioning()) return {};
	return { anchorName: `--${anchorName}` };
}
function getAnchorPositionCSS(anchorName, opts, cssVars = PopoverCSSVars) {
	const SIDE_OFFSET_VAR = `var(${cssVars.sideOffset}, 0px)`;
	const ALIGN_OFFSET_VAR = `var(${cssVars.alignOffset}, 0px)`;
	const { side, align } = opts;
	const style = {
		positionAnchor: `--${anchorName}`,
		position: "fixed",
		inset: "auto",
		margin: "0",
		justifySelf: "normal",
		alignSelf: "normal",
		marginInlineStart: "0",
		marginBlockStart: "0"
	};
	const insetProp = OPPOSITE_SIDE[side];
	if (side === "top" || side === "bottom") {
		style[insetProp] = `calc(anchor(${side}) + ${SIDE_OFFSET_VAR})`;
		if (align === "start") style.left = `calc(anchor(left) + ${ALIGN_OFFSET_VAR})`;
		else if (align === "end") style.right = `calc(anchor(right) + ${ALIGN_OFFSET_VAR})`;
		else {
			style.justifySelf = "anchor-center";
			style.marginInlineStart = ALIGN_OFFSET_VAR;
		}
	} else {
		style[insetProp] = `calc(anchor(${side}) + ${SIDE_OFFSET_VAR})`;
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
function getPositioningCSSVars(triggerRect, boundaryRect, side, cssVars = PopoverCSSVars) {
	const vars = {};
	vars[cssVars.anchorWidth] = `${triggerRect.width}px`;
	vars[cssVars.anchorHeight] = `${triggerRect.height}px`;
	if (side === "top" || side === "bottom") {
		vars[cssVars.availableHeight] = side === "top" ? `${triggerRect.top - boundaryRect.top}px` : `${boundaryRect.bottom - triggerRect.bottom}px`;
		vars[cssVars.availableWidth] = `${boundaryRect.width}px`;
	} else {
		vars[cssVars.availableWidth] = side === "left" ? `${triggerRect.left - boundaryRect.left}px` : `${boundaryRect.right - triggerRect.right}px`;
		vars[cssVars.availableHeight] = `${boundaryRect.height}px`;
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
}) {
	const { side, align } = opts;
	const { sideOffset, alignOffset } = offsets;
	let top = 0;
	let left = 0;
	if (side === "top") top = triggerRect.top - popupRect.height - sideOffset;
	else if (side === "bottom") top = triggerRect.bottom + sideOffset;
	else if (side === "left") left = triggerRect.left - popupRect.width - sideOffset;
	else left = triggerRect.right + sideOffset;
	if (side === "top" || side === "bottom") if (align === "start") left = triggerRect.left + alignOffset;
	else if (align === "end") left = triggerRect.right - popupRect.width + alignOffset;
	else left = triggerRect.left + (triggerRect.width - popupRect.width) / 2 + alignOffset;
	else if (align === "start") top = triggerRect.top + alignOffset;
	else if (align === "end") top = triggerRect.bottom - popupRect.height + alignOffset;
	else top = triggerRect.top + (triggerRect.height - popupRect.height) / 2 + alignOffset;
	return {
		top: `${top}px`,
		left: `${left}px`
	};
}
/**
* Read side-offset and align-offset CSS custom properties from the
* popup element's computed style, returning numeric pixel values.
*/
function resolveOffsets(el, cssVars = PopoverCSSVars) {
	const computed = getComputedStyle(el);
	return {
		sideOffset: resolveCSSLength(el, computed.getPropertyValue(cssVars.sideOffset)),
		alignOffset: resolveCSSLength(el, computed.getPropertyValue(cssVars.alignOffset))
	};
}
/**
* Measure the popup's layout box for positioning.
*
* `getBoundingClientRect()` includes active transforms, which causes the
* fallback position to drift while opening/closing animations scale the popup.
* Using `offsetWidth`/`offsetHeight` preserves the untransformed size.
*/
function getPopupPositionRect(el) {
	const rect = el.getBoundingClientRect();
	const width = el.offsetWidth || rect.width;
	const height = el.offsetHeight || rect.height;
	const adjustedRect = {
		...rect,
		width,
		height,
		right: rect.left + width,
		bottom: rect.top + height
	};
	return {
		...adjustedRect,
		toJSON: () => adjustedRect
	};
}

//#endregion
//#region ../utils/dist/number/number.js
/** Clamp a value between min and max (inclusive). */
function clamp(value, min, max) {
	return Math.max(min, Math.min(max, value));
}
/** Snap a value to the nearest step, offset from min. */
function roundToStep(value, step, min) {
	const nearest = Math.round((value - min) / step) * step + min;
	const dot = `${step}`.indexOf(".");
	return dot === -1 ? nearest : Number(nearest.toFixed(`${step}`.length - dot - 1));
}

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
/** Intentional drag threshold — number of pointermove events before drag starts. */
const DRAG_THRESHOLD = 2;
function createSlider(options) {
	const input = createState({
		pointerPercent: 0,
		dragPercent: 0,
		dragging: false,
		pointing: false,
		focused: false
	});
	const abort = new AbortController();
	const commitThrottleMs = options.commitThrottle ?? 0;
	let isDragging = false, moveCount = 0, cachedRTL = false, cachedRect = null, capturedPointerId = null;
	const throttledCommit = commitThrottleMs > 0 ? throttle((percent) => options.onValueCommit?.(percent), commitThrottleMs) : null;
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
			isDragging = false;
			input.patch({
				dragging: false,
				pointing: false
			});
			options.onDragEnd?.();
		}
		cleanup();
	}
	function cleanup() {
		throttledCommit?.cancel();
		capturedPointerId = null;
		cachedRect = null;
	}
	const rootProps = {
		onPointerDown(event) {
			if (options.isDisabled()) return;
			event.preventDefault();
			const el = options.getElement();
			cachedRect = el.getBoundingClientRect();
			cachedRTL = options.isRTL();
			moveCount = 0;
			releaseCapture();
			capturedPointerId = event.pointerId;
			el.setPointerCapture(event.pointerId);
			const percent = getPercentFromPointerEvent(event, cachedRect, options.getOrientation(), cachedRTL);
			input.patch({
				pointing: true,
				pointerPercent: percent,
				dragPercent: percent
			});
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
				moveCount++;
				const percent = getPercentFromPointerEvent(event, cachedRect, options.getOrientation(), cachedRTL);
				if (!isDragging && moveCount >= DRAG_THRESHOLD) {
					isDragging = true;
					input.patch({
						dragging: true,
						dragPercent: percent,
						pointerPercent: percent
					});
					options.onDragStart?.();
					options.onValueChange?.(percent);
					throttledCommit?.(percent);
				} else if (isDragging) {
					input.patch({
						dragPercent: percent,
						pointerPercent: percent
					});
					options.onValueChange?.(percent);
					throttledCommit?.(percent);
				} else input.patch({ pointerPercent: percent });
				return;
			}
			const percent = getPercentFromPointerEvent(event, options.getElement().getBoundingClientRect(), options.getOrientation(), options.isRTL());
			input.patch({
				pointing: true,
				pointerPercent: percent
			});
		},
		onPointerUp(event) {
			if (isNull(capturedPointerId)) return;
			const percent = getPercentFromPointerEvent(event, cachedRect, options.getOrientation(), cachedRTL);
			throttledCommit?.cancel();
			options.onValueCommit?.(percent);
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
				default:
					if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key >= "0" && event.key <= "9") newPercent = Number(event.key) * 10;
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
	let resizeObserver = null;
	if (options.onResize) {
		resizeObserver = new ResizeObserver(() => options.onResize());
		resizeObserver.observe(options.getElement());
	}
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
			resizeObserver?.disconnect();
			releaseCapture();
			cleanup();
		}
	};
}

//#endregion
//#region ../core/dist/default/core/ui/slider/slider-css-vars.js
/** CSS custom property names for slider visual state. */
const SliderCSSVars = {
	fill: "--media-slider-fill",
	pointer: "--media-slider-pointer",
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
//#region ../core/dist/default/core/ui/thumbnail/thumbnail-core.js
var ThumbnailCore = class {
	findActiveThumbnail(thumbnails, time) {
		if (thumbnails.length === 0) return void 0;
		let low = 0;
		let high = thumbnails.length - 1;
		let result;
		while (low <= high) {
			const mid = low + high >>> 1;
			const image = thumbnails[mid];
			if (time >= image.startTime) {
				result = image;
				low = mid + 1;
			} else high = mid - 1;
		}
		return result;
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
	let resizeObserver = null;
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
		if (!resizeObserver) {
			const container = getContainer();
			if (container) {
				resizeObserver = new ResizeObserver(onStateChange);
				resizeObserver.observe(container);
			}
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
		resizeObserver?.disconnect();
		resizeObserver = null;
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
	blur: "blur"
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
	const { onClick: _, ...baseTriggerProps } = popover.triggerProps;
	const triggerProps = {
		...baseTriggerProps,
		onPointerDown() {
			isPointerDown = true;
		},
		onPointerEnter(event) {
			if (options.disabled?.()) return;
			if (event.pointerType === "touch") return;
			baseTriggerProps.onPointerEnter(event);
		},
		onFocusIn(event) {
			if (options.disabled?.()) return;
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
		open: () => popover.open("hover"),
		close: () => popover.close("hover")
	};
}

//#endregion
//#region ../core/dist/default/dom/ui/transition.js
/**
* Manages open/close transition lifecycle via `createState`.
*
* **Open:** patches `{ active: true, status: 'starting' }`, then after a
* double-RAF patches `{ status: 'idle' }` so the browser paints the
* initial ("from") state before transitioning.
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
	function open() {
		cancelAnimationFrame(rafId1);
		cancelAnimationFrame(rafId2);
		rafId1 = 0;
		rafId2 = 0;
		state.patch({
			active: true,
			status: "starting"
		});
		return new Promise((resolve) => {
			rafId1 = requestAnimationFrame(() => {
				rafId1 = 0;
				rafId2 = requestAnimationFrame(() => {
					rafId2 = 0;
					if (destroyed || !state.current.active) return resolve();
					state.patch({ status: "idle" });
					resolve();
				});
			});
		});
	}
	function close(el) {
		cancelAnimationFrame(rafId1);
		cancelAnimationFrame(rafId2);
		rafId1 = 0;
		rafId2 = 0;
		state.patch({ status: "ending" });
		return new Promise((resolve) => {
			rafId1 = requestAnimationFrame(() => {
				rafId1 = 0;
				rafId2 = requestAnimationFrame(() => {
					rafId2 = 0;
					if (destroyed) return resolve();
					waitForAnimations(el).finally(() => {
						if (destroyed || state.current.status !== "ending") return resolve();
						state.patch({
							active: false,
							status: "idle"
						});
						resolve();
					});
				});
			});
		});
	}
	function cancel() {
		cancelAnimationFrame(rafId1);
		cancelAnimationFrame(rafId2);
		rafId1 = 0;
		rafId2 = 0;
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
function waitForAnimations(el) {
	if (!el) return Promise.resolve();
	const animations = el.getAnimations?.() ?? [];
	if (animations.length === 0) return Promise.resolve();
	return Promise.all(animations.map((a) => a.finished)).then(noop, noop);
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
//#region ../html/dist/default/_virtual/inline-css_src/define/base.js
var base_default = "video-player{display:contents}video-player video,video-player [slot=poster]{width:100%;height:100%;display:block}video-player video::-webkit-media-text-track-container{transition:translate var(--media-caption-track-duration,0) ease-out;transition-delay:var(--media-caption-track-delay,0);translate:0 var(--media-caption-track-y,0);z-index:1;font-family:inherit;scale:.98}";

//#endregion
//#region ../html/dist/default/_virtual/inline-css_src/define/shared.js
var shared_default = "media-tooltip-group{display:contents}:host{display:grid}.media-popover--volume:has(media-volume-slider[data-availability=unsupported]){display:none}";

//#endregion
//#region ../html/dist/default/define/skin-mixin.js
const STYLES_ID = "__media-styles";
function ensureRootStyles() {
	if (document.getElementById(STYLES_ID)) return;
	const style = document.createElement("style");
	style.id = STYLES_ID;
	style.textContent = base_default;
	document.head.appendChild(style);
}
const sharedSheet = new CSSStyleSheet();
sharedSheet.replaceSync(shared_default);
/**
* Mixin for skin elements that renders the template from a static
* `getTemplateHTML` method into a shadow root. Native `<slot>` elements
* handle light DOM projection automatically.
*
* When `static styles` is set, the stylesheet is adopted into the
* shadow root via `adoptedStyleSheets`.
*/
function SkinMixin(BaseClass) {
	class SkinElement extends BaseClass {
		static {
			this.shadowRootOptions = { mode: "open" };
		}
		constructor(...args) {
			super(...args);
			ensureRootStyles();
			if (!this.shadowRoot) {
				const ctor = this.constructor;
				this.attachShadow(ctor.shadowRootOptions);
				const sheets = [sharedSheet];
				if (ctor.styles) sheets.push(ctor.styles);
				this.shadowRoot.adoptedStyleSheets = sheets;
				if (ctor.getTemplateHTML) this.shadowRoot.innerHTML = ctor.getTemplateHTML();
			}
		}
	}
	return SkinElement;
}
/** Create a shared `CSSStyleSheet` from a CSS string. */
function createStyles(css) {
	const sheet = new CSSStyleSheet();
	sheet.replaceSync(css);
	return sheet;
}

//#endregion
//#region ../html/dist/default/define/media/container.js
safeDefine(MediaContainerElement);

//#endregion
//#region ../core/dist/default/core/ui/transition.js
function getTransitionFlags(status) {
	return {
		transitionStarting: status === "starting",
		transitionEnding: status === "ending"
	};
}

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
const BufferingIndicatorDataAttrs = { visible: "data-visible" };

//#endregion
//#region ../core/dist/default/core/ui/captions-button/captions-button-core.js
var CaptionsButtonCore = class CaptionsButtonCore {
	static defaultProps = {
		label: "",
		disabled: false
	};
	#props = { ...CaptionsButtonCore.defaultProps };
	#media = null;
	constructor(props) {
		if (props) this.setProps(props);
	}
	setProps(props) {
		this.#props = defaults(props, CaptionsButtonCore.defaultProps);
	}
	getLabel(state) {
		const { label } = this.#props;
		if (isFunction(label)) {
			const customLabel = label(state);
			if (customLabel) return customLabel;
		} else if (label) return label;
		return state.subtitlesShowing ? "Disable captions" : "Enable captions";
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
		return {
			subtitlesShowing: media.subtitlesShowing,
			availability: media.textTrackList.some((t) => t.kind === "captions" || t.kind === "subtitles") ? "available" : "unavailable"
		};
	}
	toggle(media) {
		if (this.#props.disabled) return;
		media.toggleSubtitles();
	}
};

//#endregion
//#region ../core/dist/default/core/ui/captions-button/captions-button-data-attrs.js
const CaptionsButtonDataAttrs = {
	subtitlesShowing: "data-active",
	availability: "data-availability"
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
	visible: "data-visible",
	userActive: "data-user-active"
};

//#endregion
//#region ../core/dist/default/core/ui/fullscreen-button/fullscreen-button-core.js
var FullscreenButtonCore = class FullscreenButtonCore {
	static defaultProps = {
		label: "",
		disabled: false
	};
	#props = { ...FullscreenButtonCore.defaultProps };
	#media = null;
	constructor(props) {
		if (props) this.setProps(props);
	}
	setProps(props) {
		this.#props = defaults(props, FullscreenButtonCore.defaultProps);
	}
	getLabel(state) {
		const { label } = this.#props;
		if (isFunction(label)) {
			const customLabel = label(state);
			if (customLabel) return customLabel;
		} else if (label) return label;
		return state.fullscreen ? "Exit fullscreen" : "Enter fullscreen";
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
		return {
			fullscreen: media.fullscreen,
			availability: media.fullscreenAvailability
		};
	}
	async toggle(media) {
		if (this.#props.disabled) return;
		if (media.fullscreenAvailability !== "available") return;
		try {
			if (media.fullscreen) await media.exitFullscreen();
			else await media.requestFullscreen();
		} catch {}
	}
};

//#endregion
//#region ../core/dist/default/core/ui/fullscreen-button/fullscreen-button-data-attrs.js
const FullscreenButtonDataAttrs = {
	fullscreen: "data-fullscreen",
	availability: "data-availability"
};

//#endregion
//#region ../core/dist/default/core/ui/mute-button/mute-button-core.js
var MuteButtonCore = class MuteButtonCore {
	static defaultProps = {
		label: "",
		disabled: false
	};
	#props = { ...MuteButtonCore.defaultProps };
	#media = null;
	constructor(props) {
		if (props) this.setProps(props);
	}
	setProps(props) {
		this.#props = defaults(props, MuteButtonCore.defaultProps);
	}
	getLabel(state) {
		const { label } = this.#props;
		if (isFunction(label)) {
			const customLabel = label(state);
			if (customLabel) return customLabel;
		} else if (label) return label;
		return state.muted ? "Unmute" : "Mute";
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
		return {
			muted: media.muted || media.volume === 0,
			volumeLevel: getVolumeLevel(media)
		};
	}
	toggle(media) {
		if (this.#props.disabled) return;
		media.toggleMuted();
	}
};
function getVolumeLevel(media) {
	if (media.muted || media.volume === 0) return "off";
	if (media.volume < .5) return "low";
	if (media.volume < .75) return "medium";
	return "high";
}

//#endregion
//#region ../core/dist/default/core/ui/mute-button/mute-button-data-attrs.js
const MuteButtonDataAttrs = {
	muted: "data-muted",
	volumeLevel: "data-volume-level"
};

//#endregion
//#region ../core/dist/default/core/ui/pip-button/pip-button-core.js
var PiPButtonCore = class PiPButtonCore {
	static defaultProps = {
		label: "",
		disabled: false
	};
	#props = { ...PiPButtonCore.defaultProps };
	#media = null;
	constructor(props) {
		if (props) this.setProps(props);
	}
	setProps(props) {
		this.#props = defaults(props, PiPButtonCore.defaultProps);
	}
	getLabel(state) {
		const { label } = this.#props;
		if (isFunction(label)) {
			const customLabel = label(state);
			if (customLabel) return customLabel;
		} else if (label) return label;
		return state.pip ? "Exit picture-in-picture" : "Enter picture-in-picture";
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
		return {
			pip: media.pip,
			availability: media.pipAvailability
		};
	}
	async toggle(media) {
		if (this.#props.disabled) return;
		if (media.pipAvailability !== "available") return;
		try {
			if (media.pip) await media.exitPictureInPicture();
			else await media.requestPictureInPicture();
		} catch {}
	}
};

//#endregion
//#region ../core/dist/default/core/ui/pip-button/pip-button-data-attrs.js
const PiPButtonDataAttrs = {
	pip: "data-pip",
	availability: "data-availability"
};

//#endregion
//#region ../core/dist/default/core/ui/play-button/play-button-core.js
var PlayButtonCore = class PlayButtonCore {
	static defaultProps = {
		label: "",
		disabled: false
	};
	#props = { ...PlayButtonCore.defaultProps };
	#media = null;
	constructor(props) {
		if (props) this.setProps(props);
	}
	setProps(props) {
		this.#props = defaults(props, PlayButtonCore.defaultProps);
	}
	getLabel(state) {
		const { label } = this.#props;
		if (isFunction(label)) {
			const customLabel = label(state);
			if (customLabel) return customLabel;
		} else if (label) return label;
		if (state.ended) return "Replay";
		return state.paused ? "Play" : "Pause";
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
		return {
			paused: media.paused,
			ended: media.ended,
			started: media.started
		};
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
	paused: "data-paused",
	ended: "data-ended",
	started: "data-started"
};

//#endregion
//#region ../core/dist/default/core/ui/playback-rate-button/playback-rate-button-core.js
var PlaybackRateButtonCore = class PlaybackRateButtonCore {
	static defaultProps = {
		label: "",
		disabled: false
	};
	#props = { ...PlaybackRateButtonCore.defaultProps };
	#media = null;
	constructor(props) {
		if (props) this.setProps(props);
	}
	setProps(props) {
		this.#props = defaults(props, PlaybackRateButtonCore.defaultProps);
	}
	getLabel(state) {
		const { label } = this.#props;
		if (isFunction(label)) {
			const customLabel = label(state);
			if (customLabel) return customLabel;
		} else if (label) return label;
		return `Playback rate ${state.rate}`;
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
		return { rate: this.#media.playbackRate };
	}
	cycle(media) {
		if (this.#props.disabled) return;
		const { playbackRates, playbackRate } = media;
		if (playbackRates.length === 0) return;
		const idx = playbackRates.indexOf(playbackRate);
		const next = idx === -1 ? playbackRates.find((r) => r > playbackRate) ?? playbackRates[0] : playbackRates[(idx + 1) % playbackRates.length];
		media.setPlaybackRate(next);
	}
};

//#endregion
//#region ../core/dist/default/core/ui/playback-rate-button/playback-rate-button-data-attrs.js
const PlaybackRateButtonDataAttrs = { rate: "data-rate" };

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
			"aria-expanded": state.open ? "true" : "false",
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
	open: "data-open",
	side: "data-side",
	align: "data-align",
	transitionStarting: "data-starting-style",
	transitionEnding: "data-ending-style"
};

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
//#region ../core/dist/default/core/ui/seek-button/seek-button-core.js
var SeekButtonCore = class SeekButtonCore {
	static defaultProps = {
		seconds: 30,
		label: "",
		disabled: false
	};
	#props = { ...SeekButtonCore.defaultProps };
	#media = null;
	constructor(props) {
		if (props) this.setProps(props);
	}
	setProps(props) {
		this.#props = defaults(props, SeekButtonCore.defaultProps);
	}
	getLabel(state) {
		const { label } = this.#props;
		if (isFunction(label)) {
			const customLabel = label(state);
			if (customLabel) return customLabel;
		} else if (label) return label;
		const abs = Math.abs(this.#props.seconds);
		return state.direction === "backward" ? `Seek backward ${abs} seconds` : `Seek forward ${abs} seconds`;
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
		return {
			seeking: this.#media.seeking,
			direction: this.#props.seconds < 0 ? "backward" : "forward"
		};
	}
	async seek(media) {
		if (this.#props.disabled) return;
		await media.seek(media.currentTime + this.#props.seconds);
	}
};

//#endregion
//#region ../core/dist/default/core/ui/seek-button/seek-button-data-attrs.js
const SeekButtonDataAttrs = {
	seeking: "data-seeking",
	direction: "data-direction"
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
		const { label } = this.#props;
		if (isFunction(label)) {
			const customLabel = label(state);
			if (customLabel) return customLabel;
		} else if (label) return label;
		return "";
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
		if (max === min) return 0;
		return (value - min) / (max - min) * 100;
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
	dragging: "data-dragging",
	pointing: "data-pointing",
	interactive: "data-interactive",
	orientation: "data-orientation",
	disabled: "data-disabled"
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
//#region ../utils/dist/time/format.js
const UNIT_LABELS = [
	{
		singular: "hour",
		plural: "hours"
	},
	{
		singular: "minute",
		plural: "minutes"
	},
	{
		singular: "second",
		plural: "seconds"
	}
];
function isValidTime(value) {
	return isNumber(value) && Number.isFinite(value);
}
function toTimeUnitPhrase(value, unitIndex) {
	return `${value} ${value === 1 ? UNIT_LABELS[unitIndex]?.singular : UNIT_LABELS[unitIndex]?.plural}`;
}
/**
* Format seconds to digital display string.
*
* @param seconds - Time in seconds (can be negative)
* @param guide - Guide time (typically duration) to determine display format
* @returns Formatted string like "1:30" or "1:05:30"
*
* @example
* formatTime(90) // "1:30"
* formatTime(3661) // "1:01:01"
* formatTime(35, 3600) // "0:00:35" (guided by 1-hour duration)
* formatTime(35, 600) // "00:35" (guided by 10-minute duration)
*/
function formatTime$1(seconds, guide) {
	if (!isValidTime(seconds)) return "0:00";
	const negative = seconds < 0;
	const positiveSeconds = Math.abs(seconds);
	const h = Math.floor(positiveSeconds / 3600);
	const m = Math.floor(positiveSeconds / 60 % 60);
	const s = Math.floor(positiveSeconds % 60);
	const guideAbs = guide ? Math.abs(guide) : 0;
	const gh = Math.floor(guideAbs / 3600);
	const gm = Math.floor(guideAbs / 60 % 60);
	const showHours = h > 0 || gh > 0;
	const padMinutes = showHours || gm >= 10;
	const hoursStr = showHours ? `${h}:` : "";
	const minutesStr = `${padMinutes && m < 10 ? "0" : ""}${m}:`;
	const secondsStr = s < 10 ? `0${s}` : `${s}`;
	return `${negative ? "-" : ""}${hoursStr}${minutesStr}${secondsStr}`;
}
/**
* Format seconds to human-readable phrase for screen readers.
*
* @param seconds - Time in seconds (negative indicates remaining)
* @returns Human-readable phrase like "1 minute, 30 seconds"
*
* @example
* formatTimeAsPhrase(90) // "1 minute, 30 seconds"
* formatTimeAsPhrase(3661) // "1 hour, 1 minute, 1 second"
* formatTimeAsPhrase(-270) // "4 minutes, 30 seconds remaining"
*/
function formatTimeAsPhrase(seconds) {
	if (!isValidTime(seconds)) return "";
	const negative = seconds < 0;
	const positiveSeconds = Math.abs(seconds);
	const h = Math.floor(positiveSeconds / 3600);
	const m = Math.floor(positiveSeconds / 60 % 60);
	const s = Math.floor(positiveSeconds % 60);
	if (positiveSeconds === 0) return `${toTimeUnitPhrase(0, 2)}${negative ? " remaining" : ""}`;
	return `${[
		h,
		m,
		s
	].map((value, index) => value > 0 ? toTimeUnitPhrase(value, index) : null).filter(Boolean).join(", ")}${negative ? " remaining" : ""}`;
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

//#endregion
//#region ../core/dist/default/core/ui/time/time-core.js
const DEFAULT_LABELS = {
	current: "Current time",
	duration: "Duration",
	remaining: "Remaining"
};
var TimeCore = class TimeCore {
	static defaultProps = {
		type: "current",
		negativeSign: "-",
		label: ""
	};
	#props = { ...TimeCore.defaultProps };
	#media = null;
	constructor(props) {
		if (props) this.setProps(props);
	}
	setProps(props) {
		this.#props = defaults(props, TimeCore.defaultProps);
	}
	setMedia(media) {
		this.#media = media;
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
		return formatTime$1(Math.abs(seconds), media.duration);
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
	getLabel(state) {
		const { label } = this.#props;
		if (isFunction(label)) {
			const customLabel = label(state);
			if (customLabel) return customLabel;
		} else if (label) return label;
		return DEFAULT_LABELS[this.#props.type];
	}
	getAttrs(state) {
		return {
			"aria-label": this.getLabel(state),
			"aria-valuetext": state.phrase
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
const TimeDataAttrs = { type: "data-type" };

//#endregion
//#region ../core/dist/default/core/ui/time-slider/time-slider-core.js
/** Time-domain slider: maps media time/buffer state to slider state. */
var TimeSliderCore = class TimeSliderCore extends SliderCore {
	static defaultProps = {
		...SliderCore.defaultProps,
		label: "Seek",
		commitThrottle: 100
	};
	#props = { ...TimeSliderCore.defaultProps };
	#media = null;
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
	getState() {
		const { duration, currentTime, seeking, buffered } = this.#media;
		const { dragging, dragPercent } = this.input;
		super.setProps({
			...this.#props,
			min: 0,
			max: duration
		});
		const value = dragging ? clamp(dragPercent / 100 * duration, 0, duration) : currentTime;
		const base = super.getSliderState(value);
		const bufferedEnd = buffered.length > 0 ? buffered[buffered.length - 1][1] : 0;
		const bufferPercent = duration > 0 ? bufferedEnd / duration * 100 : 0;
		return {
			...base,
			currentTime,
			duration,
			seeking,
			bufferPercent
		};
	}
	getLabel(state) {
		return super.getLabel(state) || "Seek";
	}
	getAttrs(state) {
		const base = super.getAttrs(state);
		const currentPhrase = formatTimeAsPhrase(state.value);
		const durationPhrase = formatTimeAsPhrase(state.duration);
		const valuetext = durationPhrase ? `${currentPhrase} of ${durationPhrase}` : currentPhrase;
		return {
			...base,
			"aria-valuetext": valuetext
		};
	}
};

//#endregion
//#region ../core/dist/default/core/ui/time-slider/time-slider-data-attrs.js
const TimeSliderDataAttrs = {
	...SliderDataAttrs,
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
	getTriggerAttrs(state, popupId) {
		return { "aria-describedby": state.open ? popupId : void 0 };
	}
	getPopupAttrs(_state) {
		return {
			popover: "manual",
			role: "tooltip"
		};
	}
};

//#endregion
//#region ../core/dist/default/core/ui/tooltip/tooltip-css-vars.js
const TooltipCSSVars = {
	sideOffset: "--media-tooltip-side-offset",
	alignOffset: "--media-tooltip-align-offset",
	anchorWidth: "--media-tooltip-anchor-width",
	anchorHeight: "--media-tooltip-anchor-height",
	availableWidth: "--media-tooltip-available-width",
	availableHeight: "--media-tooltip-available-height"
};

//#endregion
//#region ../core/dist/default/core/ui/tooltip/tooltip-data-attrs.js
const TooltipDataAttrs = {
	open: "data-open",
	side: "data-side",
	align: "data-align",
	transitionStarting: "data-starting-style",
	transitionEnding: "data-ending-style"
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
//#region ../core/dist/default/core/ui/volume-slider/volume-slider-core.js
/** Volume-domain slider: maps media volume/mute state to slider state. */
var VolumeSliderCore = class VolumeSliderCore extends SliderCore {
	static defaultProps = {
		...SliderCore.defaultProps,
		label: "Volume"
	};
	#media = null;
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
	getState() {
		const media = this.#media;
		const { volume, muted } = media;
		const effectivelyMuted = muted || volume === 0;
		const { dragging, dragPercent } = this.input;
		const volumePercent = volume * 100;
		const value = dragging ? this.valueFromPercent(dragPercent) : volumePercent;
		const base = super.getSliderState(value);
		return {
			...base,
			fillPercent: effectivelyMuted ? 0 : base.fillPercent,
			volume,
			muted: effectivelyMuted,
			availability: media.volumeAvailability
		};
	}
	getLabel(state) {
		return super.getLabel(state) || "Volume";
	}
	getAttrs(state) {
		const base = super.getAttrs(state);
		const valuetext = `${Math.round(state.value)} percent${state.muted ? ", muted" : ""}`;
		return {
			...base,
			"aria-valuetext": valuetext
		};
	}
};

//#endregion
//#region ../core/dist/default/core/ui/volume-slider/volume-slider-data-attrs.js
const VolumeSliderDataAttrs = {
	...SliderDataAttrs,
	availability: "data-availability"
};

//#endregion
//#region ../html/dist/default/ui/buffering-indicator/buffering-indicator-element.js
var BufferingIndicatorElement = class extends MediaElement {
	constructor(..._args) {
		super(..._args);
		this.delay = BufferingIndicatorCore.defaultProps.delay;
	}
	static {
		this.tagName = "media-buffering-indicator";
	}
	static {
		this.properties = { delay: { type: Number } };
	}
	#core = new BufferingIndicatorCore();
	#state = new PlayerController(this, playerContext, selectPlayback);
	#disconnect = null;
	connectedCallback() {
		super.connectedCallback();
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
//#region ../html/dist/default/define/ui/buffering-indicator.js
safeDefine(BufferingIndicatorElement);

//#endregion
//#region ../html/dist/default/ui/media-button-element.js
/** Abstract base for HTML custom elements that render a media-control button. */
var MediaButtonElement = class extends MediaElement {
	constructor(..._args) {
		super(..._args);
		this.disabled = false;
		this.label = "";
	}
	static {
		this.properties = {
			label: { type: String },
			disabled: { type: Boolean }
		};
	}
	#disconnect = null;
	connectedCallback() {
		super.connectedCallback();
		this.#disconnect = new AbortController();
		const buttonProps = createButton({
			onActivate: () => this.activate(this.mediaState.value),
			isDisabled: () => this.disabled || !this.mediaState.value
		});
		applyElementProps(this, buttonProps, { signal: this.#disconnect.signal });
	}
	disconnectedCallback() {
		super.disconnectedCallback();
		this.#disconnect?.abort();
		this.#disconnect = null;
	}
	willUpdate(changed) {
		super.willUpdate(changed);
		this.core.setProps?.(this);
	}
	update(changed) {
		super.update(changed);
		const media = this.mediaState.value;
		if (!media) return;
		this.core.setMedia(media);
		const state = this.core.getState();
		applyElementProps(this, this.core.getAttrs?.(state) ?? {});
		applyStateDataAttrs(this, state, this.stateAttrMap);
	}
};

//#endregion
//#region ../html/dist/default/ui/captions-button/captions-button-element.js
var CaptionsButtonElement = class extends MediaButtonElement {
	constructor(..._args) {
		super(..._args);
		this.core = new CaptionsButtonCore();
		this.stateAttrMap = CaptionsButtonDataAttrs;
		this.mediaState = new PlayerController(this, playerContext, selectTextTrack);
	}
	static {
		this.tagName = "media-captions-button";
	}
	activate(state) {
		this.core.toggle(state);
	}
};

//#endregion
//#region ../html/dist/default/define/ui/captions-button.js
customElements.define(CaptionsButtonElement.tagName, CaptionsButtonElement);

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
	connectedCallback() {
		super.connectedCallback();
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
	update(_changed) {
		super.update(_changed);
		const ctx = this.consumer.value;
		if (ctx) applyStateDataAttrs(this, ctx.state, ctx.stateAttrMap);
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
//#region ../html/dist/default/define/ui/controls.js
safeDefine(ControlsElement);
safeDefine(ControlsGroupElement);

//#endregion
//#region ../html/dist/default/ui/fullscreen-button/fullscreen-button-element.js
var FullscreenButtonElement = class extends MediaButtonElement {
	constructor(..._args) {
		super(..._args);
		this.core = new FullscreenButtonCore();
		this.stateAttrMap = FullscreenButtonDataAttrs;
		this.mediaState = new PlayerController(this, playerContext, selectFullscreen);
	}
	static {
		this.tagName = "media-fullscreen-button";
	}
	activate(state) {
		this.core.toggle(state);
	}
};

//#endregion
//#region ../html/dist/default/define/ui/fullscreen-button.js
safeDefine(FullscreenButtonElement);

//#endregion
//#region ../html/dist/default/ui/mute-button/mute-button-element.js
var MuteButtonElement = class extends MediaButtonElement {
	constructor(..._args) {
		super(..._args);
		this.core = new MuteButtonCore();
		this.stateAttrMap = MuteButtonDataAttrs;
		this.mediaState = new PlayerController(this, playerContext, selectVolume);
	}
	static {
		this.tagName = "media-mute-button";
	}
	activate(state) {
		this.core.toggle(state);
	}
};

//#endregion
//#region ../html/dist/default/define/ui/mute-button.js
safeDefine(MuteButtonElement);

//#endregion
//#region ../html/dist/default/ui/pip-button/pip-button-element.js
var PiPButtonElement = class extends MediaButtonElement {
	constructor(..._args) {
		super(..._args);
		this.core = new PiPButtonCore();
		this.stateAttrMap = PiPButtonDataAttrs;
		this.mediaState = new PlayerController(this, playerContext, selectPiP);
	}
	static {
		this.tagName = "media-pip-button";
	}
	activate(state) {
		this.core.toggle(state);
	}
};

//#endregion
//#region ../html/dist/default/define/ui/pip-button.js
safeDefine(PiPButtonElement);

//#endregion
//#region ../html/dist/default/ui/play-button/play-button-element.js
var PlayButtonElement = class extends MediaButtonElement {
	constructor(..._args) {
		super(..._args);
		this.core = new PlayButtonCore();
		this.stateAttrMap = PlayButtonDataAttrs;
		this.mediaState = new PlayerController(this, playerContext, selectPlayback);
	}
	static {
		this.tagName = "media-play-button";
	}
	activate(state) {
		this.core.toggle(state);
	}
};

//#endregion
//#region ../html/dist/default/define/ui/play-button.js
safeDefine(PlayButtonElement);

//#endregion
//#region ../html/dist/default/ui/playback-rate-button/playback-rate-button-element.js
var PlaybackRateButtonElement = class extends MediaButtonElement {
	constructor(..._args) {
		super(..._args);
		this.core = new PlaybackRateButtonCore();
		this.stateAttrMap = PlaybackRateButtonDataAttrs;
		this.mediaState = new PlayerController(this, playerContext, selectPlaybackRate);
	}
	static {
		this.tagName = "media-playback-rate-button";
	}
	activate(state) {
		this.core.cycle(state);
	}
};

//#endregion
//#region ../html/dist/default/define/ui/playback-rate-button.js
safeDefine(PlaybackRateButtonElement);

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
			}
		};
	}
	#core = new PopoverCore();
	#popover = null;
	#snapshot = null;
	#disconnect = null;
	#triggerAbort = null;
	#currentTrigger = null;
	#positionAbort = null;
	#positionFrame = 0;
	#resizeObserver = null;
	#positionTrigger = null;
	connectedCallback() {
		super.connectedCallback();
		if (this.destroyed) return;
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
			closeDelay: () => this.closeDelay
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
		this.#cleanupPositioning();
		this.#disconnect?.abort();
		this.#disconnect = null;
	}
	destroyCallback() {
		this.#cleanupPositioning();
		this.#cleanupTrigger();
		this.#popover?.destroy();
		super.destroyCallback();
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
		const triggerEl = this.#findTrigger();
		this.#syncTrigger(triggerEl);
		const input = this.#popover.input.current;
		this.#core.setInput(input);
		const state = this.#core.getState();
		applyElementProps(this, this.#core.getPopupAttrs(state));
		applyStateDataAttrs(this, state, PopoverDataAttrs);
		if (state.open) tryShowPopover(this);
		else tryHidePopover(this);
		if (this.#currentTrigger) {
			applyElementProps(this.#currentTrigger, this.#core.getTriggerAttrs(state, this.id));
			applyStyles(this.#currentTrigger, getAnchorNameStyle(this.id));
		}
		if (!state.open) {
			this.#cleanupPositioning();
			return;
		}
		const posOpts = {
			side: state.side,
			align: state.align
		};
		if (supportsAnchorPositioning()) applyStyles(this, getAnchorPositionStyle(this.id, posOpts));
		else {
			const triggerRect = this.#currentTrigger?.getBoundingClientRect();
			const selfRect = getPopupPositionRect(this);
			const boundaryRect = document.documentElement.getBoundingClientRect();
			const offsets = resolveOffsets(this);
			applyStyles(this, getAnchorPositionStyle(this.id, posOpts, triggerRect, selfRect, boundaryRect, offsets));
		}
		this.#syncPositioning();
	}
	#findTrigger() {
		if (!this.id) return null;
		return this.getRootNode().querySelector(`[commandfor="${this.id}"]`);
	}
	#syncTrigger(triggerEl) {
		if (triggerEl === this.#currentTrigger) return;
		this.#cleanupPositioning();
		this.#cleanupTrigger();
		this.#currentTrigger = triggerEl;
		this.#popover?.setTriggerElement(triggerEl);
		if (triggerEl && this.#popover) {
			this.#triggerAbort = new AbortController();
			applyElementProps(triggerEl, this.#popover.triggerProps, { signal: this.#triggerAbort.signal });
		}
	}
	#cleanupTrigger() {
		if (this.#currentTrigger) {
			applyElementProps(this.#currentTrigger, {
				"aria-expanded": void 0,
				"aria-haspopup": void 0,
				"aria-controls": void 0
			});
			this.#currentTrigger.style.removeProperty("anchor-name");
		}
		this.#triggerAbort?.abort();
		this.#triggerAbort = null;
		this.#currentTrigger = null;
	}
	#syncPositioning() {
		if (supportsAnchorPositioning()) return;
		const triggerEl = this.#currentTrigger;
		if (!triggerEl) return;
		if (this.#positionAbort && this.#positionTrigger === triggerEl) return;
		this.#cleanupPositioning();
		this.#positionAbort = new AbortController();
		this.#positionTrigger = triggerEl;
		const { signal } = this.#positionAbort;
		const reposition = () => {
			cancelAnimationFrame(this.#positionFrame);
			this.#positionFrame = requestAnimationFrame(() => {
				if (signal.aborted) return;
				this.requestUpdate();
			});
		};
		window.addEventListener("scroll", reposition, {
			capture: true,
			passive: true,
			signal
		});
		window.addEventListener("resize", reposition, { signal });
		if (typeof ResizeObserver === "function") {
			this.#resizeObserver = new ResizeObserver(() => {
				reposition();
			});
			this.#resizeObserver.observe(triggerEl);
			this.#resizeObserver.observe(this);
		}
		reposition();
	}
	#cleanupPositioning() {
		this.#positionAbort?.abort();
		this.#positionAbort = null;
		this.#positionTrigger = null;
		cancelAnimationFrame(this.#positionFrame);
		this.#positionFrame = 0;
		this.#resizeObserver?.disconnect();
		this.#resizeObserver = null;
	}
};

//#endregion
//#region ../html/dist/default/define/ui/popover.js
safeDefine(PopoverElement);

//#endregion
//#region ../html/dist/default/ui/media-ui-element.js
/** Abstract base for HTML custom elements that display media state with data attributes. */
var MediaUIElement = class extends MediaElement {
	connectedCallback() {
		super.connectedCallback();
	}
	update(changed) {
		super.update(changed);
		const media = this.mediaState.value;
		if (!media) return;
		this.core.setMedia(media);
		const state = this.core.getState();
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
};

//#endregion
//#region ../html/dist/default/define/ui/poster.js
safeDefine(PosterElement);

//#endregion
//#region ../html/dist/default/ui/seek-button/seek-button-element.js
var SeekButtonElement = class extends MediaButtonElement {
	constructor(..._args) {
		super(..._args);
		this.seconds = SeekButtonCore.defaultProps.seconds;
		this.core = new SeekButtonCore();
		this.stateAttrMap = SeekButtonDataAttrs;
		this.mediaState = new PlayerController(this, playerContext, selectTime);
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
	activate(state) {
		this.core.seek(state);
	}
};

//#endregion
//#region ../html/dist/default/define/ui/seek-button.js
safeDefine(SeekButtonElement);

//#endregion
//#region ../html/dist/default/ui/time/time-element.js
var TimeElement = class extends MediaElement {
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
			label: { type: String }
		};
	}
	#core = new TimeCore();
	#state = new PlayerController(this, playerContext, selectTime);
	#signSpan = document.createElement("span");
	#textNode = document.createTextNode("");
	constructor() {
		super();
		this.type = TimeCore.defaultProps.type;
		this.negativeSign = TimeCore.defaultProps.negativeSign;
		this.label = TimeCore.defaultProps.label;
		this.#signSpan.setAttribute("aria-hidden", "true");
		this.#signSpan.hidden = true;
		this.appendChild(this.#signSpan);
		this.appendChild(this.#textNode);
	}
	connectedCallback() {
		super.connectedCallback();
	}
	willUpdate(changed) {
		super.willUpdate(changed);
		this.#core.setProps(this);
	}
	update(changed) {
		super.update(changed);
		const media = this.#state.value;
		if (!media) return;
		this.#core.setMedia(media);
		const state = this.#core.getState();
		this.#signSpan.hidden = !state.negative;
		this.#signSpan.textContent = state.negative ? this.negativeSign : "";
		this.#textNode.textContent = state.text;
		applyElementProps(this, this.#core.getAttrs(state));
		applyStateDataAttrs(this, state, TimeDataAttrs);
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
//#region ../html/dist/default/define/ui/time.js
safeDefine(TimeElement);
safeDefine(TimeGroupElement);
safeDefine(TimeSeparatorElement);

//#endregion
//#region ../html/dist/default/ui/slider/context.js
const sliderContext = n(Symbol("@videojs/slider"));

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
	#core = new ThumbnailCore();
	#img = document.createElement("img");
	#textTracks = new PlayerController(this, playerContext, selectTextTrack);
	#thumbnails = [];
	#externalThumbnails;
	#lastTextTrack;
	#api = null;
	constructor() {
		super();
		this.time = 0;
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
	}
	static {
		this.tagName = "media-slider-value";
	}
	static {
		this.properties = { type: { type: String } };
	}
	#ctx = new s$1(this, {
		context: sliderContext,
		subscribe: true
	});
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
//#region ../html/dist/default/ui/time-slider/time-slider-element.js
var TimeSliderElement = class extends MediaElement {
	constructor(..._args) {
		super(..._args);
		this.label = TimeSliderCore.defaultProps.label;
		this.commitThrottle = TimeSliderCore.defaultProps.commitThrottle;
		this.step = TimeSliderCore.defaultProps.step;
		this.largeStep = TimeSliderCore.defaultProps.largeStep;
		this.orientation = TimeSliderCore.defaultProps.orientation;
		this.disabled = TimeSliderCore.defaultProps.disabled;
		this.thumbAlignment = TimeSliderCore.defaultProps.thumbAlignment;
	}
	static {
		this.tagName = "media-time-slider";
	}
	static {
		this.properties = {
			label: { type: String },
			commitThrottle: {
				type: Number,
				attribute: "commit-throttle"
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
			}
		};
	}
	#core = new TimeSliderCore();
	#provider = new i(this, { context: sliderContext });
	#timeState = new PlayerController(this, playerContext, selectTime);
	#bufferState = new PlayerController(this, playerContext, selectBuffer);
	#slider = null;
	#disconnect = null;
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
			commitThrottle: this.commitThrottle,
			onDragStart: () => {
				this.dispatchEvent(new CustomEvent("drag-start", { bubbles: true }));
			},
			onDragEnd: () => {
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
		super.disconnectedCallback();
		this.#disconnect?.abort();
		this.#disconnect = null;
	}
	destroyCallback() {
		this.#slider?.destroy();
		super.destroyCallback();
	}
	willUpdate(_changed) {
		super.willUpdate(_changed);
		this.#core.setProps(this);
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
		applyStyles(this, cssVars);
		applyStateDataAttrs(this, state, TimeSliderDataAttrs);
		this.#provider.setValue({
			state,
			stateAttrMap: TimeSliderDataAttrs,
			pointerValue: this.#core.valueFromPercent(state.pointerPercent),
			thumbAttrs: this.#core.getAttrs(state),
			thumbProps: this.#slider.thumbProps,
			formatValue: (value) => formatTime$1(value, state.duration)
		});
	}
};

//#endregion
//#region ../html/dist/default/ui/slider/slider-preview-element.js
var SliderPreviewElement = class extends MediaElement {
	constructor(..._args) {
		super(..._args);
		this.overflow = "clamp";
	}
	static {
		this.tagName = "media-slider-preview";
	}
	static {
		this.properties = { overflow: { type: String } };
	}
	#ctx = new s$1(this, {
		context: sliderContext,
		subscribe: true
	});
	#resizeObserver = null;
	#width = 0;
	connectedCallback() {
		super.connectedCallback();
		this.#resizeObserver = new ResizeObserver(([entry]) => {
			this.#width = entry.contentRect.width;
			this.#applyPosition();
		});
		this.#resizeObserver.observe(this);
	}
	disconnectedCallback() {
		super.disconnectedCallback();
		this.#resizeObserver?.disconnect();
		this.#resizeObserver = null;
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
//#region ../html/dist/default/define/ui/time-slider.js
safeDefine(TimeSliderElement);
safeDefine(SliderBufferElement);
safeDefine(SliderFillElement);
safeDefine(SliderPreviewElement);
safeDefine(SliderThumbElement);
safeDefine(SliderThumbnailElement);
safeDefine(SliderTrackElement);
safeDefine(SliderValueElement);

//#endregion
//#region ../html/dist/default/ui/tooltip/context.js
const tooltipGroupContext = n(Symbol("@videojs/tooltip-group"));

//#endregion
//#region ../html/dist/default/ui/tooltip/tooltip-element.js
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
			disabled: { type: Boolean }
		};
	}
	#core = new TooltipCore();
	#groupConsumer = new s$1(this, { context: tooltipGroupContext });
	#tooltip = null;
	#snapshot = null;
	#disconnect = null;
	#triggerAbort = null;
	#currentTrigger = null;
	#positionAbort = null;
	#positionFrame = 0;
	#resizeObserver = null;
	#positionTrigger = null;
	connectedCallback() {
		super.connectedCallback();
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
			group: () => this.#groupConsumer.value
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
		this.#cleanupPositioning();
		this.#cleanupTrigger();
		this.#tooltip?.destroy();
		this.#tooltip = null;
		this.#disconnect?.abort();
		this.#disconnect = null;
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
		const triggerEl = this.#findTrigger();
		this.#syncTrigger(triggerEl);
		const input = this.#tooltip.input.current;
		this.#core.setInput(input);
		const state = this.#core.getState();
		applyElementProps(this, this.#core.getPopupAttrs(state));
		applyStateDataAttrs(this, state, TooltipDataAttrs);
		if (state.open) tryShowPopover(this);
		else tryHidePopover(this);
		if (this.#currentTrigger) {
			applyElementProps(this.#currentTrigger, this.#core.getTriggerAttrs(state, this.id));
			applyStyles(this.#currentTrigger, getAnchorNameStyle(this.id));
		}
		if (!state.open) {
			this.#cleanupPositioning();
			return;
		}
		const posOpts = {
			side: state.side,
			align: state.align
		};
		if (supportsAnchorPositioning()) applyStyles(this, getAnchorPositionStyle(this.id, posOpts, void 0, void 0, void 0, void 0, TooltipCSSVars));
		else {
			const triggerRect = this.#currentTrigger?.getBoundingClientRect();
			const selfRect = getPopupPositionRect(this);
			const boundaryRect = document.documentElement.getBoundingClientRect();
			const offsets = resolveOffsets(this, TooltipCSSVars);
			applyStyles(this, getAnchorPositionStyle(this.id, posOpts, triggerRect, selfRect, boundaryRect, offsets, TooltipCSSVars));
		}
		this.#syncPositioning();
	}
	#findTrigger() {
		if (!this.id) return null;
		return this.getRootNode().querySelector(`[commandfor="${this.id}"]`);
	}
	#syncTrigger(triggerEl) {
		if (triggerEl === this.#currentTrigger) return;
		this.#cleanupPositioning();
		this.#cleanupTrigger();
		this.#currentTrigger = triggerEl;
		this.#tooltip?.setTriggerElement(triggerEl);
		if (triggerEl && this.#tooltip) {
			this.#triggerAbort = new AbortController();
			applyElementProps(triggerEl, this.#tooltip.triggerProps, { signal: this.#triggerAbort.signal });
		}
	}
	#cleanupTrigger() {
		if (this.#currentTrigger) {
			applyElementProps(this.#currentTrigger, { "aria-describedby": void 0 });
			this.#currentTrigger.style.removeProperty("anchor-name");
		}
		this.#triggerAbort?.abort();
		this.#triggerAbort = null;
		this.#currentTrigger = null;
	}
	#syncPositioning() {
		if (supportsAnchorPositioning()) return;
		const triggerEl = this.#currentTrigger;
		if (!triggerEl) return;
		if (this.#positionAbort && this.#positionTrigger === triggerEl) return;
		this.#cleanupPositioning();
		this.#positionAbort = new AbortController();
		this.#positionTrigger = triggerEl;
		const { signal } = this.#positionAbort;
		const reposition = () => {
			cancelAnimationFrame(this.#positionFrame);
			this.#positionFrame = requestAnimationFrame(() => {
				if (signal.aborted) return;
				this.requestUpdate();
			});
		};
		window.addEventListener("scroll", reposition, {
			capture: true,
			passive: true,
			signal
		});
		window.addEventListener("resize", reposition, { signal });
		if (typeof ResizeObserver === "function") {
			this.#resizeObserver = new ResizeObserver(() => {
				reposition();
			});
			this.#resizeObserver.observe(triggerEl);
			this.#resizeObserver.observe(this);
		}
		reposition();
	}
	#cleanupPositioning() {
		this.#positionAbort?.abort();
		this.#positionAbort = null;
		this.#positionTrigger = null;
		cancelAnimationFrame(this.#positionFrame);
		this.#positionFrame = 0;
		this.#resizeObserver?.disconnect();
		this.#resizeObserver = null;
	}
};

//#endregion
//#region ../html/dist/default/define/ui/tooltip.js
safeDefine(TooltipElement);

//#endregion
//#region ../html/dist/default/ui/tooltip/tooltip-group-element.js
var TooltipGroupElement = class extends MediaElement {
	constructor(..._args) {
		super(..._args);
		this.delay = TooltipGroupCore.defaultProps.delay;
		this.closeDelay = TooltipGroupCore.defaultProps.closeDelay;
		this.timeout = TooltipGroupCore.defaultProps.timeout;
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
	#core = new TooltipGroupCore();
	#provider = new i(this, {
		context: tooltipGroupContext,
		initialValue: this.#core
	});
	update(_changed) {
		super.update(_changed);
		this.#core.setProps(this);
		this.#provider.setValue(this.#core);
	}
};

//#endregion
//#region ../html/dist/default/define/ui/tooltip-group.js
safeDefine(TooltipGroupElement);

//#endregion
//#region ../html/dist/default/ui/volume-slider/volume-slider-element.js
var VolumeSliderElement = class extends MediaElement {
	constructor(..._args) {
		super(..._args);
		this.label = VolumeSliderCore.defaultProps.label;
		this.step = VolumeSliderCore.defaultProps.step;
		this.largeStep = VolumeSliderCore.defaultProps.largeStep;
		this.orientation = VolumeSliderCore.defaultProps.orientation;
		this.disabled = VolumeSliderCore.defaultProps.disabled;
		this.thumbAlignment = VolumeSliderCore.defaultProps.thumbAlignment;
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
			orientation: { type: String },
			disabled: { type: Boolean },
			thumbAlignment: {
				type: String,
				attribute: "thumb-alignment"
			}
		};
	}
	#core = new VolumeSliderCore();
	#provider = new i(this, { context: sliderContext });
	#volumeState = new PlayerController(this, playerContext, selectVolume);
	#slider = null;
	#disconnect = null;
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
			isDisabled: () => this.disabled || !this.#volumeState.value,
			getPercent: () => {
				const media = this.#volumeState.value;
				if (!media) return 0;
				return media.volume * 100;
			},
			getStepPercent: () => this.#core.getStepPercent(),
			getLargeStepPercent: () => this.#core.getLargeStepPercent(),
			onValueChange: (percent) => {
				this.#setVolume(percent);
			},
			onValueCommit: (percent) => {
				this.#setVolume(percent);
			},
			onDragStart: () => {
				this.dispatchEvent(new CustomEvent("drag-start", { bubbles: true }));
			},
			onDragEnd: () => {
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
		super.disconnectedCallback();
		this.#disconnect?.abort();
		this.#disconnect = null;
	}
	destroyCallback() {
		this.#slider?.destroy();
		super.destroyCallback();
	}
	willUpdate(_changed) {
		super.willUpdate(_changed);
		this.#core.setProps(this);
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
		applyStyles(this, cssVars);
		applyStateDataAttrs(this, state, VolumeSliderDataAttrs);
		this.#provider.setValue({
			state,
			stateAttrMap: VolumeSliderDataAttrs,
			pointerValue: this.#core.valueFromPercent(state.pointerPercent),
			thumbAttrs: this.#core.getAttrs(state),
			thumbProps: this.#slider.thumbProps,
			formatValue: (value) => `${Math.round(value)}%`
		});
	}
	#setVolume(percent) {
		this.#volumeState.value?.setVolume(this.#core.valueFromPercent(percent) / 100);
	}
};

//#endregion
//#region ../html/dist/default/define/ui/volume-slider.js
safeDefine(VolumeSliderElement);
safeDefine(SliderFillElement);
safeDefine(SliderPreviewElement);
safeDefine(SliderThumbElement);
safeDefine(SliderTrackElement);
safeDefine(SliderValueElement);

//#endregion
//#region ../html/dist/default/icons/dist/render/default/index.js
const icons = {
	"captions-off": `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" aria-hidden="true" viewBox="0 0 18 18"><rect width="16" height="12" x="1" y="3" stroke="currentColor" stroke-width="2" rx="3"/><rect width="3" height="2" x="3" y="8" fill="currentColor" rx="1"/><rect width="2" height="2" x="13" y="8" fill="currentColor" rx="1"/><rect width="4" height="2" x="11" y="11" fill="currentColor" rx="1"/><rect width="5" height="2" x="7" y="8" fill="currentColor" rx="1"/><rect width="7" height="2" x="3" y="11" fill="currentColor" rx="1"/></svg>`,
	"captions-on": `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" aria-hidden="true" viewBox="0 0 18 18"><path fill="currentColor" d="M15 2a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H3a3 3 0 0 1-3-3V5a3 3 0 0 1 3-3zM4 11a1 1 0 1 0 0 2h5a1 1 0 1 0 0-2zm8 0a1 1 0 1 0 0 2h2a1 1 0 1 0 0-2zM4 8a1 1 0 0 0 0 2h1a1 1 0 0 0 0-2zm4 0a1 1 0 0 0 0 2h3a1 1 0 1 0 0-2zm6 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2"/></svg>`,
	"fullscreen-enter": `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" aria-hidden="true" viewBox="0 0 18 18"><path fill="currentColor" d="M9.57 3.617A1 1 0 0 0 8.646 3H4c-.552 0-1 .449-1 1v4.646a.996.996 0 0 0 1.001 1 1 1 0 0 0 .706-.293l4.647-4.647a1 1 0 0 0 .216-1.089m4.812 4.812a1 1 0 0 0-1.089.217l-4.647 4.647a.998.998 0 0 0 .708 1.706H14c.552 0 1-.449 1-1V9.353a1 1 0 0 0-.618-.924"/></svg>`,
	"fullscreen-exit": `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" aria-hidden="true" viewBox="0 0 18 18"><path fill="currentColor" d="M7.883 1.93a.99.99 0 0 0-1.09.217L2.146 6.793A.998.998 0 0 0 2.853 8.5H7.5c.551 0 1-.449 1-1V2.854a1 1 0 0 0-.617-.924m7.263 7.57H10.5c-.551 0-1 .449-1 1v4.646a.996.996 0 0 0 1.001 1.001 1 1 0 0 0 .706-.293l4.646-4.646a.998.998 0 0 0-.707-1.707z"/></svg>`,
	"pause": `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" aria-hidden="true" viewBox="0 0 18 18"><rect width="5" height="14" x="2" y="2" fill="currentColor" rx="1.75"/><rect width="5" height="14" x="11" y="2" fill="currentColor" rx="1.75"/></svg>`,
	"pip-enter": `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" aria-hidden="true" viewBox="0 0 18 18"><path fill="currentColor" d="M13 2a4 4 0 0 1 4 4v2.035A3.5 3.5 0 0 0 16.5 8H15V6.273C15 5.018 13.96 4 12.679 4H4.32C3.04 4 2 5.018 2 6.273v5.454C2 12.982 3.04 14 4.321 14H6v1.5q0 .255.035.5H4a4 4 0 0 1-4-4V6a4 4 0 0 1 4-4z"/><rect width="10" height="7" x="8" y="10" fill="currentColor" rx="2"/><path fill="currentColor" d="M7.129 5.547a.6.6 0 0 0-.656.13L3.677 8.473A.6.6 0 0 0 4.102 9.5h2.796c.332 0 .602-.27.602-.602V6.103a.6.6 0 0 0-.371-.556"/></svg>`,
	"pip-exit": `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" aria-hidden="true" viewBox="0 0 18 18"><path fill="currentColor" d="M13 2a4 4 0 0 1 4 4v2.036A3.5 3.5 0 0 0 16.5 8H15V6.273C15 5.018 13.96 4 12.679 4H4.32C3.04 4 2 5.018 2 6.273v5.454C2 12.982 3.04 14 4.321 14H6v1.5q0 .255.036.5H4a4 4 0 0 1-4-4V6a4 4 0 0 1 4-4z"/><rect width="10" height="7" x="8" y="10" fill="currentColor" rx="2"/><path fill="currentColor" d="M4.871 10.454a.6.6 0 0 0 .656-.131l2.796-2.796A.6.6 0 0 0 7.898 6.5H5.102a.603.603 0 0 0-.602.602v2.795a.6.6 0 0 0 .371.556"/></svg>`,
	"play": `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" aria-hidden="true" viewBox="0 0 18 18"><path fill="currentColor" d="m14.051 10.723-7.985 4.964a1.98 1.98 0 0 1-2.758-.638A2.06 2.06 0 0 1 3 13.964V4.036C3 2.91 3.895 2 5 2c.377 0 .747.109 1.066.313l7.985 4.964a2.057 2.057 0 0 1 .627 2.808c-.16.257-.373.475-.627.637"/></svg>`,
	"restart": `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" aria-hidden="true" viewBox="0 0 18 18"><path fill="currentColor" d="M9 17a8 8 0 0 1-8-8h2a6 6 0 1 0 1.287-3.713l1.286 1.286A.25.25 0 0 1 5.396 7H1.25A.25.25 0 0 1 1 6.75V2.604a.25.25 0 0 1 .427-.177l1.438 1.438A8 8 0 1 1 9 17"/><path fill="currentColor" d="m11.61 9.639-3.331 2.07a.826.826 0 0 1-1.15-.266.86.86 0 0 1-.129-.452V6.849C7 6.38 7.374 6 7.834 6c.158 0 .312.045.445.13l3.331 2.071a.858.858 0 0 1 0 1.438"/></svg>`,
	"seek": `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" aria-hidden="true" viewBox="0 0 18 18"><path fill="currentColor" d="M1 9c0 2.21.895 4.21 2.343 5.657l1.414-1.414a6 6 0 1 1 8.956-7.956l-1.286 1.286a.25.25 0 0 0 .177.427h4.146a.25.25 0 0 0 .25-.25V2.604a.25.25 0 0 0-.427-.177l-1.438 1.438A8 8 0 0 0 1 9"/></svg>`,
	"spinner": `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" aria-hidden="true" viewBox="0 0 18 18"><rect width="2" height="5" x="8" y=".5" opacity=".5" rx="1"><animate attributeName="opacity" begin="0s" calcMode="linear" dur="1s" repeatCount="indefinite" values="1;0"/></rect><rect width="2" height="5" x="12.243" y="2.257" opacity=".45" rx="1" transform="rotate(45 13.243 4.757)"><animate attributeName="opacity" begin="0.125s" calcMode="linear" dur="1s" repeatCount="indefinite" values="1;0"/></rect><rect width="5" height="2" x="12.5" y="8" opacity=".4" rx="1"><animate attributeName="opacity" begin="0.25s" calcMode="linear" dur="1s" repeatCount="indefinite" values="1;0"/></rect><rect width="5" height="2" x="10.743" y="12.243" opacity=".35" rx="1" transform="rotate(45 13.243 13.243)"><animate attributeName="opacity" begin="0.375s" calcMode="linear" dur="1s" repeatCount="indefinite" values="1;0"/></rect><rect width="2" height="5" x="8" y="12.5" opacity=".3" rx="1"><animate attributeName="opacity" begin="0.5s" calcMode="linear" dur="1s" repeatCount="indefinite" values="1;0"/></rect><rect width="2" height="5" x="3.757" y="10.743" opacity=".25" rx="1" transform="rotate(45 4.757 13.243)"><animate attributeName="opacity" begin="0.625s" calcMode="linear" dur="1s" repeatCount="indefinite" values="1;0"/></rect><rect width="5" height="2" x=".5" y="8" opacity=".15" rx="1"><animate attributeName="opacity" begin="0.75s" calcMode="linear" dur="1s" repeatCount="indefinite" values="1;0"/></rect><rect width="5" height="2" x="2.257" y="3.757" opacity=".1" rx="1" transform="rotate(45 4.757 4.757)"><animate attributeName="opacity" begin="0.875s" calcMode="linear" dur="1s" repeatCount="indefinite" values="1;0"/></rect></svg>`,
	"volume-high": `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" aria-hidden="true" viewBox="0 0 18 18"><path fill="currentColor" d="M15.6 3.3c-.4-.4-1-.4-1.4 0s-.4 1 0 1.4C15.4 5.9 16 7.4 16 9s-.6 3.1-1.8 4.3c-.4.4-.4 1 0 1.4.2.2.5.3.7.3.3 0 .5-.1.7-.3C17.1 13.2 18 11.2 18 9s-.9-4.2-2.4-5.7"/><path fill="currentColor" d="M.714 6.008h3.072l4.071-3.857c.5-.376 1.143 0 1.143.601V15.28c0 .602-.643.903-1.143.602l-4.071-3.858H.714c-.428 0-.714-.3-.714-.752V6.76c0-.451.286-.752.714-.752m10.568.59a.91.91 0 0 1 0-1.316.91.91 0 0 1 1.316 0c1.203 1.203 1.47 2.216 1.522 3.208q.012.255.011.51c0 1.16-.358 2.733-1.533 3.803a.7.7 0 0 1-.298.156c-.382.106-.873-.011-1.018-.156a.91.91 0 0 1 0-1.316c.57-.57.995-1.551.995-2.487 0-.944-.26-1.667-.995-2.402"/></svg>`,
	"volume-low": `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" aria-hidden="true" viewBox="0 0 18 18"><path fill="currentColor" d="M.714 6.008h3.072l4.071-3.857c.5-.376 1.143 0 1.143.601V15.28c0 .602-.643.903-1.143.602l-4.071-3.858H.714c-.428 0-.714-.3-.714-.752V6.76c0-.451.286-.752.714-.752m10.568.59a.91.91 0 0 1 0-1.316.91.91 0 0 1 1.316 0c1.203 1.203 1.47 2.216 1.522 3.208q.012.255.011.51c0 1.16-.358 2.733-1.533 3.803a.7.7 0 0 1-.298.156c-.382.106-.873-.011-1.018-.156a.91.91 0 0 1 0-1.316c.57-.57.995-1.551.995-2.487 0-.944-.26-1.667-.995-2.402"/></svg>`,
	"volume-off": `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" aria-hidden="true" viewBox="0 0 18 18"><path fill="currentColor" d="M.714 6.008h3.072l4.071-3.857c.5-.376 1.143 0 1.143.601V15.28c0 .602-.643.903-1.143.602l-4.071-3.858H.714c-.428 0-.714-.3-.714-.752V6.76c0-.451.286-.752.714-.752M14.5 7.586l-1.768-1.768a1 1 0 1 0-1.414 1.414L13.085 9l-1.767 1.768a1 1 0 0 0 1.414 1.414l1.768-1.768 1.768 1.768a1 1 0 0 0 1.414-1.414L15.914 9l1.768-1.768a1 1 0 0 0-1.414-1.414z"/></svg>`
};
function renderIcon(name, attrs) {
	const svg = icons[name];
	if (!svg) return "";
	if (!attrs) return svg;
	const attrStr = Object.entries(attrs).map(([k, v]) => ` ${k}="${v}"`).join("");
	return svg.replace("<svg", `<svg${attrStr}`);
}

//#endregion
//#region ../html/dist/default/_virtual/inline-css_src/define/video/skin.js
var skin_default = ".media-default-skin *,.media-default-skin :before,.media-default-skin :after{box-sizing:border-box}.media-default-skin img,.media-default-skin video,.media-default-skin svg{max-width:100%;display:block}.media-default-skin button{font:inherit}@media (prefers-reduced-motion:no-preference){.media-default-skin{interpolate-size:allow-keywords}}.media-default-skin{isolation:isolate;border-radius:var(--media-border-radius,2rem);letter-spacing:normal;-webkit-font-smoothing:auto;-moz-osx-font-smoothing:auto;width:100%;height:100%;font-family:Inter Variable,Inter,ui-sans-serif,system-ui,sans-serif;font-size:.8125rem;line-height:1.5;display:block;position:relative;container:media-root/inline-size}.media-default-skin .media-surface{background-color:var(--media-surface-background-color);backdrop-filter:var(--media-surface-backdrop-filter);box-shadow:0 0 0 1px var(--media-surface-outer-border-color), 0 1px 3px 0 var(--media-surface-shadow-color), 0 1px 2px -1px var(--media-surface-shadow-color);&:after{content:\"\";z-index:10;border-radius:inherit;box-shadow:inset 0 0 0 1px var(--media-surface-inner-border-color);pointer-events:none;position:absolute;inset:0}@media (prefers-reduced-transparency:reduce){background-color:oklch(from var(--media-surface-background-color) l c h / .7)}@media (prefers-contrast:more){background-color:oklch(from var(--media-surface-background-color) l c h / .9)}}.media-default-skin ::slotted(video),.media-default-skin video{object-fit:var(--media-object-fit,contain);object-position:var(--media-object-position,center);width:100%;height:100%;display:block}.media-default-skin ::slotted(video){border-radius:var(--media-video-border-radius)}.media-default-skin video{border-radius:inherit}.media-default-skin:fullscreen ::slotted(video),.media-default-skin:fullscreen video{object-fit:contain}.media-default-skin .media-overlay{border-radius:inherit;backdrop-filter:blur()saturate(1.5);opacity:0;pointer-events:none;transition-property:opacity,backdrop-filter;transition-duration:var(--media-controls-transition-duration);transition-delay:var(--media-controls-transition-delay);background-image:linear-gradient(oklch(0% 0 0/0),oklch(0% 0 0/.3),oklch(0% 0 0/.5));transition-timing-function:ease-out;position:absolute;inset:0}.media-default-skin .media-error~.media-overlay{transition-duration:var(--media-error-dialog-transition-duration);transition-delay:var(--media-error-dialog-transition-delay)}.media-default-skin .media-controls[data-visible]~.media-overlay,.media-default-skin .media-error[data-open]~.media-overlay{opacity:1}.media-default-skin .media-error[data-open]~.media-overlay{backdrop-filter:blur(16px)saturate(1.5)}.media-default-skin .media-buffering-indicator{color:oklch(100% 0 0);pointer-events:none;justify-content:center;align-items:center;display:none;position:absolute;inset:0;&[data-visible]{display:flex}& .media-surface{border-radius:100%;padding:.25rem}}.media-default-skin .media-error{outline:none}.media-default-skin .media-error__title{font-weight:600;line-height:1.25}.media-default-skin .media-error__description{opacity:.7;overflow-wrap:anywhere}.media-default-skin .media-error__actions{gap:.5rem;display:flex;&>*{flex:1}}.media-default-skin .media-error[data-open]~.media-controls *{visibility:hidden}.media-default-skin .media-controls{--media-controls-current-shadow-color:oklch(from currentColor 0 0 0 / clamp(0, calc((l - .5) * .5), .15));--media-controls-current-shadow-color-subtle:oklch(from var(--media-controls-current-shadow-color) l c h / calc(alpha * .4));text-shadow:0 1px 0 var(--media-controls-current-shadow-color);border-radius:3.40282e38px;align-items:center;gap:.075rem;padding:.175rem;display:flex;container:media-controls/inline-size;@container media-root (width>40rem){gap:.125rem;padding:.25rem}}.media-default-skin .media-time{flex:1;align-items:center;gap:.75rem;padding-inline:.5rem;display:flex;container:media-time/inline-size;& .media-time__value:first-child{display:none;@container media-time (width>18rem){display:block}}}.media-default-skin .media-time__value{font-variant-numeric:tabular-nums}.media-default-skin .media-button{outline-offset:-2px;cursor:pointer;user-select:none;text-align:center;touch-action:manipulation;border:none;border-radius:3.40282e38px;outline:2px solid #0000;flex-shrink:0;justify-content:center;align-items:center;padding:.5rem 1rem;transition-property:background-color,outline-offset,scale;transition-duration:.15s;transition-timing-function:ease-out;display:flex;&:focus-visible{outline-offset:2px;outline-color:currentColor}&:active{scale:.98}&[disabled]{opacity:.5;filter:grayscale();cursor:not-allowed}&[data-availability=unavailable]{display:none}}.media-default-skin .media-button--primary{color:oklch(0% 0 0);text-shadow:none;background:oklch(100% 0 0);font-weight:500}.media-default-skin .media-button--subtle{color:inherit;text-shadow:inherit;background:0 0;&:hover,&:focus-visible,&[aria-expanded=true]{background-color:oklch(from currentColor l c h / .1);text-decoration:none}}.media-default-skin .media-button--icon{aspect-ratio:1;width:2.125rem;padding:0;display:grid;&:active{scale:.9}& .media-icon{filter:drop-shadow(0 1px 0 var(--media-controls-current-shadow-color,oklch(0% 0 0/.25)))}}.media-default-skin .media-button--seek{& .media-icon__label{font-variant-numeric:tabular-nums;font-size:10px;font-weight:480;position:absolute;bottom:-3px;right:-1px}&:has(.media-icon--flipped) .media-icon__label{right:unset;left:-1px}@container media-controls (width<28rem){display:none}}.media-default-skin .media-button--playback-rate{padding:0;&:after{content:attr(data-rate) \"×\";font-variant-numeric:tabular-nums;width:4ch}}.media-default-skin .media-icon__container{position:relative}.media-default-skin .media-icon{transition-behavior:allow-discrete;flex-shrink:0;grid-area:1/1;width:18px;height:18px;transition-property:display,opacity;transition-duration:.15s;transition-timing-function:ease-out;display:block}.media-default-skin .media-icon--flipped{scale:-1 1}.media-default-skin media-poster,.media-default-skin>img{pointer-events:none;width:100%;height:100%;transition:opacity .25s;position:absolute;inset:0}.media-default-skin media-poster:not([data-visible]),.media-default-skin>img:not([data-visible]){opacity:0}.media-default-skin media-poster ::slotted(img){object-fit:var(--media-object-fit,contain);object-position:var(--media-object-position,center);border-radius:var(--media-video-border-radius);width:100%;height:100%;position:absolute;inset:0}.media-default-skin>img{object-fit:var(--media-object-fit,contain);object-position:var(--media-object-position,center);border-radius:inherit}.media-default-skin:fullscreen media-poster ::slotted(img),.media-default-skin:fullscreen>img{object-fit:contain}.media-default-skin .media-preview{background-color:oklch(0% 0 0/.9);border-radius:.75rem;& .media-preview__thumbnail{border-radius:inherit;display:block;position:relative;overflow:clip;&:after{content:\"\";border-radius:inherit;background-image:linear-gradient(oklch(0% 0 0/0),oklch(0% 0 0/.3),oklch(0% 0 0/.8));position:absolute;inset:0}}& .media-preview__timestamp{bottom:.5rem;text-align:center;font-variant-numeric:tabular-nums;position:absolute;inset-inline:0}& .media-overlay{opacity:1}& .media-preview__spinner{opacity:0;position:absolute;top:50%;left:50%;translate:-50% -50%}& .media-preview__thumbnail,& .media-preview__spinner{transition:opacity .15s ease-out}&:has(.media-preview__thumbnail[data-loading]){& .media-preview__thumbnail{opacity:0}& .media-preview__spinner{opacity:1}}}.media-default-skin .media-slider{cursor:pointer;border-radius:3.40282e38px;outline:none;flex:1;justify-content:center;align-items:center;display:flex;position:relative;&[data-orientation=horizontal]{width:100%;min-width:5rem;height:1.25rem}&[data-orientation=vertical]{width:1.25rem;height:5rem}}.media-default-skin .media-slider__track{isolation:isolate;border-radius:inherit;user-select:none;position:relative;overflow:hidden;&[data-orientation=horizontal]{width:100%;height:.25rem}&[data-orientation=vertical]{width:.25rem;height:100%}}.media-default-skin .media-slider__thumb{z-index:10;width:.625rem;height:.625rem;box-shadow:0 0 0 1px var(--media-controls-current-shadow-color-subtle,oklch(0% 0 0/.1)), 0 1px 3px 0 oklch(0% 0 0/.15), 0 1px 2px -1px oklch(0% 0 0/.15);opacity:0;user-select:none;outline-offset:-4px;background-color:currentColor;border-radius:3.40282e38px;outline:4px solid #0000;transition-property:opacity,height,width,outline-offset;transition-duration:.15s;transition-timing-function:ease-out;position:absolute;translate:-50% -50%;&[data-orientation=horizontal]{top:50%;left:var(--media-slider-fill)}&[data-orientation=vertical]{left:50%;top:calc(100% - var(--media-slider-fill))}&:hover,&:focus{outline-color:oklch(from currentColor l c h / .25);outline-offset:0}&:after{content:\"\";border-radius:inherit;transition-property:opacity,scale;transition-duration:.15s;transition-timing-function:ease-out;position:absolute;inset:-4px;box-shadow:0 0 0 2px oklch(100% 0 0)}&:not(:focus-visible):after{opacity:0;scale:.5}}.media-default-skin .media-slider:active .media-slider__thumb,.media-default-skin .media-slider__thumb--persistent{width:.75rem;height:.75rem}.media-default-skin .media-slider:hover .media-slider__thumb,.media-default-skin .media-slider__thumb:focus-visible,.media-default-skin .media-slider__thumb--persistent{opacity:1}.media-default-skin .media-slider__buffer,.media-default-skin .media-slider__fill{border-radius:inherit;pointer-events:none;position:absolute}.media-default-skin .media-slider__buffer[data-orientation=horizontal],.media-default-skin .media-slider__fill[data-orientation=horizontal]{inset-block:0;left:0}.media-default-skin .media-slider__buffer[data-orientation=vertical],.media-default-skin .media-slider__fill[data-orientation=vertical]{inset-inline:0;bottom:0}.media-default-skin .media-slider__buffer{background-color:oklch(from currentColor l c h / .2);transition-duration:.25s;transition-timing-function:ease-out;&[data-orientation=horizontal]{width:var(--media-slider-buffer);transition-property:width}&[data-orientation=vertical]{height:var(--media-slider-buffer);transition-property:height}}.media-default-skin .media-slider__fill{background-color:currentColor;&[data-orientation=horizontal]{width:var(--media-slider-fill)}&[data-orientation=vertical]{height:var(--media-slider-fill)}}.media-default-skin .media-popover,.media-default-skin .media-tooltip{color:inherit;transition-property:scale,opacity,filter;transition-duration:var(--media-popup-transition-duration);transition-timing-function:var(--media-popup-transition-timing-function);border:0;margin:0;overflow:visible;&[data-starting-style],&[data-ending-style]{opacity:0;filter:blur(8px);scale:.5}&[data-instant]{transition-duration:0s}&[data-side=top]{transform-origin:bottom}&[data-side=bottom]{transform-origin:top}&[data-side=left]{transform-origin:100%}&[data-side=right]{transform-origin:0}&:before{content:\"\";pointer-events:inherit;position:absolute}&[data-side=top]:before,&[data-side=bottom]:before{width:100%;inset-inline:0}&[data-side=top]:before{top:100%}&[data-side=bottom]:before{bottom:100%}&[data-side=left]:before,&[data-side=right]:before{height:100%;inset-block:0}&[data-side=left]:before{left:100%}&[data-side=right]:before{right:100%}}.media-default-skin .media-popover{--media-popover-side-offset:.5rem;&[data-side=top]:before,&[data-side=bottom]:before{height:var(--media-popover-side-offset)}&[data-side=left]:before,&[data-side=right]:before{width:var(--media-popover-side-offset)}}.media-default-skin .media-popover--volume{border-radius:3.40282e38px;padding:.625rem .25rem;&:has(media-volume-slider[data-availability=unsupported]){display:none}}.media-default-skin .media-tooltip{white-space:nowrap;--media-tooltip-side-offset:.75rem;border-radius:3.40282e38px;padding:.25rem .625rem;font-size:.75rem;&[data-side=top]:before,&[data-side=bottom]:before{height:var(--media-tooltip-side-offset)}&[data-side=left]:before,&[data-side=right]:before{width:var(--media-tooltip-side-offset)}}.media-default-skin{--media-caption-track-duration:var(--media-controls-transition-duration);--media-caption-track-delay:calc(var(--media-controls-transition-delay) + 25ms);--media-caption-track-y:-.5rem;&:has(.media-controls[data-visible]){--media-caption-track-y:-3.5rem}}.media-default-skin video::-webkit-media-text-track-container{transition:translate var(--media-caption-track-duration) ease-out;transition-delay:var(--media-caption-track-delay);translate:0 var(--media-caption-track-y);z-index:1;font-family:inherit;scale:.98}.media-button--play .media-icon--restart,.media-button--play .media-icon--play,.media-button--play .media-icon--pause,.media-button--mute .media-icon--volume-off,.media-button--mute .media-icon--volume-low,.media-button--mute .media-icon--volume-high,.media-button--fullscreen .media-icon--fullscreen-enter,.media-button--fullscreen .media-icon--fullscreen-exit,.media-button--pip .media-icon--pip-enter,.media-button--pip .media-icon--pip-exit,.media-button--captions .media-icon--captions-off,.media-button--captions .media-icon--captions-on{opacity:0;display:none}.media-button--play[data-ended] .media-icon--restart,.media-button--play:not([data-ended])[data-paused] .media-icon--play,.media-button--play:not([data-paused]):not([data-ended]) .media-icon--pause,.media-button--mute[data-muted] .media-icon--volume-off,.media-button--mute:not([data-muted])[data-volume-level=low] .media-icon--volume-low,.media-button--mute:not([data-muted]):not([data-volume-level=low]) .media-icon--volume-high,.media-button--fullscreen:not([data-fullscreen]) .media-icon--fullscreen-enter,.media-button--fullscreen[data-fullscreen] .media-icon--fullscreen-exit,.media-button--pip:not([data-pip]) .media-icon--pip-enter,.media-button--pip[data-pip] .media-icon--pip-exit,.media-button--captions:not([data-active]) .media-icon--captions-off,.media-button--captions[data-active] .media-icon--captions-on{opacity:1;display:block}.media-tooltip-label{display:none}.media-button--play[data-ended]+.media-tooltip .media-tooltip-label--replay,.media-button--play:not([data-ended])[data-paused]+.media-tooltip .media-tooltip-label--play,.media-button--play:not([data-paused]):not([data-ended])+.media-tooltip .media-tooltip-label--pause,.media-button--fullscreen:not([data-fullscreen])+.media-tooltip .media-tooltip-label--enter-fullscreen,.media-button--fullscreen[data-fullscreen]+.media-tooltip .media-tooltip-label--exit-fullscreen,.media-button--captions:not([data-active])+.media-tooltip .media-tooltip-label--enable-captions,.media-button--captions[data-active]+.media-tooltip .media-tooltip-label--disable-captions,.media-button--pip:not([data-pip])+.media-tooltip .media-tooltip-label--enter-pip,.media-button--pip[data-pip]+.media-tooltip .media-tooltip-label--exit-pip{display:block}.media-default-skin--video{--media-spring-transition:linear(0, .034 1.5%, .763 9.7%, 1.066 13.9%, 1.198 19.9%, 1.184 21.8%, .963 37.5%, .997 50.9%, 1);--media-border-color:oklch(0% 0 0/.1);--media-surface-background-color:oklch(100% 0 0/.1);--media-surface-inner-border-color:oklch(100% 0 0/.05);--media-surface-outer-border-color:oklch(0% 0 0/.1);--media-surface-shadow-color:oklch(0% 0 0/.15);--media-surface-backdrop-filter:blur(16px) saturate(1.5);--media-video-border-radius:var(--media-border-radius,2rem);--media-controls-transition-duration:.1s;--media-controls-transition-delay:0s;--media-controls-transition-timing-function:ease-out;--media-error-dialog-transition-duration:.35s;--media-error-dialog-transition-delay:.1s;--media-error-dialog-transition-timing-function:var(--media-spring-transition);--media-popup-transition-duration:.1s;--media-popup-transition-timing-function:ease-out;background:oklch(0% 0 0);@media (prefers-reduced-motion:reduce){--media-error-dialog-transition-duration:50ms;--media-error-dialog-transition-delay:0s;--media-error-dialog-transition-timing-function:ease-out;--media-popup-transition-duration:0s}@media (prefers-color-scheme:dark){--media-border-color:oklch(100% 0 0/.15)}&:has(.media-controls:not([data-visible])){@media (pointer:fine){--media-controls-transition-delay:.5s;--media-controls-transition-duration:.3s}@media (pointer:coarse){--media-controls-transition-duration:.15s}@media (prefers-reduced-motion:reduce){--media-controls-transition-duration:50ms}}&:after{content:\"\";z-index:10;border-radius:inherit;box-shadow:inset 0 0 0 1px var(--media-border-color);pointer-events:none;position:absolute;inset:0}&:fullscreen{--media-border-radius:0}}.media-default-skin--video .media-error{z-index:20;justify-content:center;align-items:center;display:flex;position:absolute;inset:0}.media-default-skin--video .media-error__dialog{color:oklch(100% 0 0);text-shadow:0 1px oklch(0% 0 0/.25);max-width:18rem;transition-property:opacity,scale;transition-duration:var(--media-error-dialog-transition-duration);transition-delay:var(--media-error-dialog-transition-delay);transition-timing-function:var(--media-error-dialog-transition-timing-function);border-radius:1.75rem;flex-direction:column;gap:.75rem;padding:.75rem;display:flex}.media-default-skin--video .media-error[data-starting-style] .media-error__dialog,.media-default-skin--video .media-error[data-ending-style] .media-error__dialog{opacity:0;scale:.5}.media-default-skin--video .media-error[data-ending-style] .media-error__dialog{transition-delay:0s}.media-default-skin--video .media-error__content{text-shadow:inherit;flex-direction:column;gap:.5rem;padding:.5rem .5rem .375rem;display:flex}.media-default-skin--video .media-error__title{font-size:1rem}.media-default-skin--video .media-controls{bottom:.75rem;z-index:10;color:var(--media-color-primary,oklch(100% 0 0));transition-duration:var(--media-controls-transition-duration);transition-delay:var(--media-controls-transition-delay);transition-timing-function:var(--media-controls-transition-timing-function);transform-origin:bottom;position:absolute;inset-inline:.75rem;@media (pointer:fine){will-change:scale, filter, opacity;transition-property:scale,filter,opacity}@media (pointer:coarse){will-change:scale, opacity;transition-property:scale,opacity}&:not([data-visible]){opacity:0;pointer-events:none;scale:.9;@media (pointer:fine) and (prefers-reduced-motion:no-preference){filter:blur(8px)}@media (prefers-reduced-motion:reduce){scale:1}}}.media-default-skin--video .media-error[data-open]~.media-controls{display:none}@media (pointer:fine){.media-default-skin--video:fullscreen:has(.media-controls:not([data-visible])){cursor:none}}.media-default-skin--video .media-slider__track{background-color:oklch(100% 0 0/.2);box-shadow:0 0 0 1px oklch(0% 0 0/.05)}.media-default-skin--video .media-slider__preview{left:var(--media-slider-pointer);opacity:0;filter:blur(8px);transform-origin:bottom;pointer-events:none;transition-property:scale,opacity,filter;transition-duration:.15s;transition-timing-function:ease-out;position:absolute;bottom:calc(100% + 1.2rem);translate:-50%;scale:.8;& .media-preview__thumbnail{max-width:11rem}&:has(.media-preview__thumbnail[data-loading]){max-height:6rem}}.media-default-skin--video .media-slider[data-pointing] .media-slider__preview:has([role=img]:not([data-hidden])){opacity:1;filter:blur();scale:1}";

//#endregion
//#region ../html/dist/default/define/video/skin.js
const SEEK_TIME = 10;
function getTemplateHTML() {
	return `<media-container class="media-default-skin media-default-skin--video"><slot name="media"></slot><slot></slot><media-poster><slot name="poster"></slot></media-poster><media-buffering-indicator class="media-buffering-indicator"><div class="media-surface"> ${renderIcon("spinner", { class: "media-icon" })} </div></media-buffering-indicator><media-controls class="media-surface media-controls"><media-tooltip-group><media-play-button commandfor="play-tooltip" class="media-button media-button--subtle media-button--icon media-button--play"> ${renderIcon("restart", { class: "media-icon media-icon--restart" })} ${renderIcon("play", { class: "media-icon media-icon--play" })} ${renderIcon("pause", { class: "media-icon media-icon--pause" })} </media-play-button><media-tooltip id="play-tooltip" side="top" class="media-surface media-tooltip"><span class="media-tooltip-label media-tooltip-label--replay">Replay</span><span class="media-tooltip-label media-tooltip-label--play">Play</span><span class="media-tooltip-label media-tooltip-label--pause">Pause</span></media-tooltip><media-seek-button commandfor="seek-backward-tooltip" seconds="${-SEEK_TIME}" class="media-button media-button--subtle media-button--icon media-button--seek"> <span class="media-icon__container"> ${renderIcon("seek", { class: "media-icon media-icon--flipped" })} <span class="media-icon__label">${SEEK_TIME}</span></span></media-seek-button><media-tooltip id="seek-backward-tooltip" side="top" class="media-surface media-tooltip"> Seek backward ${SEEK_TIME} seconds </media-tooltip><media-seek-button commandfor="seek-forward-tooltip" seconds="${SEEK_TIME}" class="media-button media-button--subtle media-button--icon media-button--seek"> <span class="media-icon__container"> ${renderIcon("seek", { class: "media-icon" })} <span class="media-icon__label">${SEEK_TIME}</span></span></media-seek-button><media-tooltip id="seek-forward-tooltip" side="top" class="media-surface media-tooltip"> Seek forward ${SEEK_TIME} seconds </media-tooltip><media-time-group class="media-time"><media-time type="current" class="media-time__value"></media-time><media-time-slider class="media-slider"><media-slider-track class="media-slider__track"><media-slider-fill class="media-slider__fill"></media-slider-fill><media-slider-buffer class="media-slider__buffer"></media-slider-buffer></media-slider-track><media-slider-thumb class="media-slider__thumb"></media-slider-thumb><div class="media-surface media-preview media-slider__preview"><media-slider-thumbnail class="media-preview__thumbnail"></media-slider-thumbnail><media-slider-value type="pointer" class="media-preview__timestamp"></media-slider-value> ${renderIcon("spinner", { class: "media-preview__spinner media-icon" })} </div></media-time-slider><media-time type="duration" class="media-time__value"></media-time></media-time-group><media-playback-rate-button commandfor="playback-rate-tooltip" class="media-button media-button--subtle media-button--icon media-button--playback-rate"></media-playback-rate-button><media-tooltip id="playback-rate-tooltip" side="top" class="media-surface media-tooltip"> Toggle playback rate </media-tooltip><media-mute-button commandfor="video-volume-popover" class="media-button media-button--subtle media-button--icon media-button--mute"> ${renderIcon("volume-off", { class: "media-icon media-icon--volume-off" })} ${renderIcon("volume-low", { class: "media-icon media-icon--volume-low" })} ${renderIcon("volume-high", { class: "media-icon media-icon--volume-high" })} </media-mute-button><media-popover id="video-volume-popover" open-on-hover delay="200" close-delay="100" side="top" class="media-surface media-popover media-popover--volume"><media-volume-slider class="media-slider" orientation="vertical" thumb-alignment="edge"><media-slider-track class="media-slider__track"><media-slider-fill class="media-slider__fill"></media-slider-fill></media-slider-track><media-slider-thumb class="media-slider__thumb media-slider__thumb--persistent"></media-slider-thumb></media-volume-slider></media-popover><media-captions-button commandfor="captions-tooltip" class="media-button media-button--subtle media-button--icon media-button--captions"> ${renderIcon("captions-off", { class: "media-icon media-icon--captions-off" })} ${renderIcon("captions-on", { class: "media-icon media-icon--captions-on" })} </media-captions-button><media-tooltip id="captions-tooltip" side="top" class="media-surface media-tooltip"><span class="media-tooltip-label media-tooltip-label--enable-captions">Enable captions</span><span class="media-tooltip-label media-tooltip-label--disable-captions">Disable captions</span></media-tooltip><media-pip-button commandfor="pip-tooltip" class="media-button media-button--subtle media-button--icon media-button--pip"> ${renderIcon("pip-enter", { class: "media-icon media-icon--pip-enter" })} ${renderIcon("pip-exit", { class: "media-icon media-icon--pip-exit" })} </media-pip-button><media-tooltip id="pip-tooltip" side="top" class="media-surface media-tooltip"><span class="media-tooltip-label media-tooltip-label--enter-pip">Enter picture-in-picture</span><span class="media-tooltip-label media-tooltip-label--exit-pip">Exit picture-in-picture</span></media-tooltip><media-fullscreen-button commandfor="fullscreen-tooltip" class="media-button media-button--subtle media-button--icon media-button--fullscreen"> ${renderIcon("fullscreen-enter", { class: "media-icon media-icon--fullscreen-enter" })} ${renderIcon("fullscreen-exit", { class: "media-icon media-icon--fullscreen-exit" })} </media-fullscreen-button><media-tooltip id="fullscreen-tooltip" side="top" class="media-surface media-tooltip"><span class="media-tooltip-label media-tooltip-label--enter-fullscreen">Enter fullscreen</span><span class="media-tooltip-label media-tooltip-label--exit-fullscreen">Exit fullscreen</span></media-tooltip></media-tooltip-group></media-controls><div class="media-overlay"></div></media-container>`;
}
var VideoSkinElement = class extends SkinMixin(ReactiveElement) {
	static {
		this.tagName = "video-skin";
	}
	static {
		this.styles = createStyles(skin_default);
	}
	static {
		this.getTemplateHTML = getTemplateHTML;
	}
};
customElements.define(VideoSkinElement.tagName, VideoSkinElement);

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
//# sourceMappingURL=video-ads.dev.js.map