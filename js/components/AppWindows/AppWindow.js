/**
 * AppWindow.js — generic movable AppWindow window.
 *
 * Completely decoupled from what goes inside it. Give it a title and,
 * optionally, a body node — it just provides window chrome. Reuse it for
 * anything: the REGO600 panel, a WiFi settings form, a log viewer, etc.
 *
 * Two chrome styles, both from the same class:
 *   - Free-floating tool window (default): draggable, no backdrop, can
 *     stay open alongside other UI. Used by the REGO600 panel.
 *   - Blocking dialog: `backdrop: true` adds a dimmed overlay, click-outside
 *     and Escape both close it, and dialog ARIA attributes are set
 *     automatically. Typically paired with `draggable: false`. Used by
 *     the WiFi setup form.
 *
 * Usage:
 *   const AppWindow = new AppWindow({ title: "REGO600 Control Panel" });
 *   AppWindow.setBody(someElement);
 *   AppWindow.setFooter(someButtonRow);  // optional
 *   AppWindow.mount();   // attaches to document.body
 *   AppWindow.open();
 */

class AppWindow extends EventTarget{

	static get TYPE() {
        return this.name;
    }
	
	static Modes = Object.freeze({
		Open: 0,
		Minimized: 1,
		Closed: 3
	});
	static ModeToString = Object.fromEntries(
		Object.keys(AppWindow.Modes).map(key => [AppWindow.Modes[key], key])
	);
	static StringToMode = Object.fromEntries(
		Object.entries(AppWindow.Modes).map(([key, value]) => [key, value])
	);
	#mode = AppWindow.Modes.Closed;
	getModeAsString() {
		return AppWindow.ModeToString[this.mode] ?? AppWindow.Modes.Closed;
	}
	setModeFromString(mode) {
		if (typeof mode == "string") {
			this.mode = AppWindow.StringToMode[mode];
		} else {
			this.mode = mode;
		}
	}
	get mode() {
		return this.#mode;
	}
	set mode(newMode) {
		if (newMode == undefined) {
			newMode = AppWindow.Modes.Closed;
		}
		const oldMode = this.#mode;

		if (oldMode == newMode) {
			return;
		}

		this.#mode = newMode;

		if (this.isOpen(newMode)) {
			if (this.isClosed(oldMode)) {
				AppWindows.emit("open", this);
				requestAnimationFrame(() => {
					this.onOpen?.(this);
				});
			} else if (this.isMinimized(oldMode)) {
				AppWindows.emit("show", this);
				requestAnimationFrame(() => {
					this.onShow?.(this);
				});
			}
		} else if (this.isClosed(newMode)) {
			AppWindows.emit("close", this);
			this.onClose?.(this);
		} else if (this.isMinimized(newMode)) {
			AppWindows.emit("minimize", this);
			this.onMinimize?.(this);
		}
	}
	/** here mode is optional, and if omitted the internal mode is used */
	isOpen(mode=undefined) {
		return (mode ?? this.mode) == AppWindow.Modes.Open;
	}
	/** here mode is optional, and if omitted the internal mode is used */
	isClosed(mode=undefined) {
		return (mode ?? this.mode) == AppWindow.Modes.Closed;
	}
	/** here mode is optional, and if omitted the internal mode is used */
	isMinimized(mode=undefined) {
		return (mode ?? this.mode) == AppWindow.Modes.Minimized;
	}
	#setOpen() {
		if (this.mode == AppWindow.Modes.Open) {
			AppWindows.emit('show', this);
			return;
		}
		this.mode = AppWindow.Modes.Open;
	}
	#setClosed() {
		this.mode = AppWindow.Modes.Closed;
	}
	#setMinimized() {
		this.mode = AppWindow.Modes.Minimized;
	}

	#remove_px(style) {
		if (style.endsWith('px')) {
			return parseInt(style.substring(0,style.length-2));
		} else if (style.length != 0) {
			return parseInt(style);
		} else {
			return 0;
		}
	}

	getStates() {
		let width = this.#remove_px(this.el.style.width);
		let height = this.#remove_px(this.el.style.height);
		let x = this.#remove_px(this.el.style.left);
		let y = this.#remove_px(this.el.style.top);
		if (width == 0) { width = undefined; }
		if (height == 0) { height = undefined; }
		//console.log(x, y, width, height);
		return {
			type: this.constructor.TYPE,
			x,
			y,
			width,
			height,
			mode: this.getModeAsString(),
			tabIndex: this.tabIndex??0
		};
	}

	setStates(states) {
		
		if (states.width && states.width != 0) {
			this.el.style.width = states.width + 'px'
		}
		if (states.height && states.height != 0) {
			this.el.style.height = states.height + 'px'
		}
		// this must be set after width is set
		// as if x and y is not given the new window is placed center on screen
		this.#setInitialPosition(states.x, states.y);
		
		this.setModeFromString(states.mode);
		this.tabIndex = states.tabIndex ?? 0;

		this.#setVisible(this.isOpen());

		return this;
	}

	constructor({
		title = "",
		/** when singleton is true canBeDestroyed is automatically set to false */
		singleton = false,
		closable = true,
		minimizable = true,
		draggable = true,
		backdrop = false,
		resizable = false,
		closeOnBackdropClick = true,
		closeOnEscape = backdrop,
		canBeDestroyed = true,
		onClose,
		onOpen,
		onShow,
		onMinimize,
	} = {}) {
		super();
		this.#setClosed();
		this.title = title,
		this.onClose = onClose;
		this.onOpen = onOpen;
		this.onShow = onShow;
		this.onMinimize = onMinimize;
		this.hasBackdrop = backdrop;
		this.canBeDestroyed = canBeDestroyed;

		this.el = document.createElement("div");
		this.el.className = "AppWindow";

		this.header_el = document.createElement("div");
		this.header_el.className = "AppWindow-header";

		this.title_el = document.createElement("div");
		this.title_el.className = "AppWindow-title";
		this.title_el.textContent = title;
		this.header_el.appendChild(this.title_el);

		if (backdrop) {
			this.el.setAttribute("role", "dialog");
			this.el.setAttribute("aria-modal", "true");
			this.el.setAttribute("aria-labelledby", this.title_el.id);
		}
		let windowControls_el = document.createElement("div");
		windowControls_el.className = "AppWindow-controls";
		this.header_el.appendChild(windowControls_el);
		if (minimizable) {
			this.minimizeBtn_el = document.createElement("button");
			this.minimizeBtn_el.className = "AppWindow-control AppWindow-minimize";
			this.minimizeBtn_el.type = "button";
			this.minimizeBtn_el.setAttribute("aria-label", "Minimize");
			this.minimizeBtn_el.textContent = "_";
			this.minimizeBtn_el.addEventListener("pointerdown", (e) => { e.stopPropagation(); });
			this.minimizeBtn_el.addEventListener("click", () => this.#minimize());
			windowControls_el.appendChild(this.minimizeBtn_el);
		}

		if (closable) {
			this.closeBtn_el = document.createElement("button");
			this.closeBtn_el.className = "AppWindow-control AppWindow-close";
			this.closeBtn_el.type = "button";
			this.closeBtn_el.setAttribute("aria-label", "Close");
			this.closeBtn_el.textContent = "\u00d7";
			this.closeBtn_el.addEventListener("pointerdown", (e) => { e.stopPropagation(); });
			this.closeBtn_el.addEventListener("click", () => this.close());
			windowControls_el.appendChild(this.closeBtn_el);
		}

		this.body_el = document.createElement("div");
		this.body_el.className = "AppWindow-body";

		this.footer_el = document.createElement("div");
		this.footer_el.className = "AppWindow-footer";
		this.footer_el.style.display = "none"; // hidden until setFooter() is used

		this.el.appendChild(this.header_el);
		this.el.appendChild(this.body_el);
		this.el.appendChild(this.footer_el);

		this.el.addEventListener("pointerdown", (e) => {
			//e.stopPropagation();
			this.#show();
		});

		if (backdrop) {
			this.backdrop_el = document.createElement("div");
			this.backdrop_el.className = "AppWindow-backdrop";
			
			
			this.backdrop_el.appendChild(this.el);
			if (closeOnBackdropClick) {
				this.backdrop_el.addEventListener("click", (e) => {
					if (e.target === this.backdrop_el) this.close();
				});
			}
		} 

		if (closeOnEscape) {
			this._onEscape = (e) => {
				if (e.key === "Escape" && this.isOpen()) this.close();
			};
		}

		if (draggable) { 
			this.#makeDraggable(this.header_el);
		}
		if (resizable) {
			this.#makeResizable();
		}
	
		this.#mount();
	
		AppWindows.addToList(this);
		if (singleton === true) {
			AppWindows.SetAsSingleton(this);
		}
		AppWindows.emit("added", this);
	}

	#setInitialPosition(x, y) {
		// Default: roughly centered, offset slightly so multiple AppWindows cascade.
		const left = x ?? Math.max(20, (window.innerWidth - (parseInt(this.el.style.width) || 400)) / 2);
		const top = y ?? Math.max(20, window.innerHeight * 0.1);
		this.el.style.left = `${left}px`;
		this.el.style.top = `${top}px`;
	}

	#makeDraggable(handle) {
		let dragging = false;
		let startX, startY, startLeft, startTop;

		const onPointerDown = (e) => {
			// Ignore drags started on the close button.
			if (e.target.closest(".AppWindow-close")) return;
			dragging = true;
			const rect = this.el.getBoundingClientRect();
			startX = e.clientX;
			startY = e.clientY;
			startLeft = rect.left;
			startTop = rect.top;
			this.el.classList.add("AppWindow--dragging");
			handle.setPointerCapture(e.pointerId);
		};

		const onPointerMove = (e) => {
			if (!dragging) return;
			const dx = e.clientX - startX;
			const dy = e.clientY - startY;
			const maxLeft = window.innerWidth - this.el.offsetWidth;
			const maxTop = window.innerHeight - this.el.offsetHeight;
			const left = Math.min(Math.max(0, startLeft + dx), Math.max(0, maxLeft));
			const top = Math.min(Math.max(0, startTop + dy), Math.max(0, maxTop));
			this.el.style.left = `${left}px`;
			this.el.style.top = `${top}px`;
		};

		const onPointerUp = (e) => {
			dragging = false;
			this.el.classList.remove("AppWindow--dragging");
			try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
			AppWindows.emit('moved', this);
		};

		handle.addEventListener("pointerdown", onPointerDown);
		handle.addEventListener("pointermove", onPointerMove);
		handle.addEventListener("pointerup", onPointerUp);
		handle.addEventListener("pointercancel", onPointerUp);
	}

	#addResizeHandle(className, resizeFn) {
		const handle = document.createElement("div");
		handle.className = `AppWindow-resize-handle ${className}`;
		this.el.appendChild(handle);

		let resizing = false;
		
		let startWidth, startHeight;
		let startPointerX , startPointerY;
		let startLeft, startTop;

		const onPointerDown = (e) => {
			resizing = true;
			this.#show();

			const rect = this.el.getBoundingClientRect();

			startPointerX = e.clientX;
			startPointerY = e.clientY;

			startLeft = rect.left;
			startTop = rect.top;

			startWidth = rect.width;
			startHeight = rect.height;

			this.el.classList.add("AppWindow--resizing");

			handle.setPointerCapture(e.pointerId);

			e.preventDefault();
			e.stopPropagation();
		};

		const onPointerMove = (e) => {
			if (!resizing) return;

			const dx = e.clientX - startPointerX;
			const dy = e.clientY - startPointerY;

			const minWidth = 250;
			const minHeight = 150;

			const size = resizeFn(
				startLeft,
				startTop,
				startWidth,
				startHeight,
				dx,
				dy,
				minWidth,
				minHeight
			);

			this.el.style.left = `${size.x}px`;
			this.el.style.top = `${size.y}px`;
			this.el.style.width = `${size.width}px`;
			this.el.style.height = `${size.height}px`;
		};

		const onPointerUp = (e) => {
			resizing = false;

			this.el.classList.remove("AppWindow--resizing");

			try {
				handle.releasePointerCapture(e.pointerId);
			} catch (ex) {
				console.log("AppWindow resize error:", ex);
			}
			AppWindows.emit('resized', this);
		};

		handle.addEventListener("pointerdown", onPointerDown);
		handle.addEventListener("pointermove", onPointerMove);
		handle.addEventListener("pointerup", onPointerUp);
		handle.addEventListener("pointercancel", onPointerUp);

		return handle;
	}

	#makeResizable() {

		this.#addResizeHandle("top-left", (x, y, w, h, dx, dy, minW, minH) => 
			{
				const width = Math.max(minW, w - dx);
				const height = Math.max(minH, h - dy);

				return {
					x: x + (w - width),
					y: y + (h - height),
					width,
					height
				};
			}
		);

		this.#addResizeHandle("top-right", (x, y, w, h, dx, dy, minW, minH) => {
			const width = Math.max(minW, w + dx);
			const height = Math.max(minH, h - dy);

			return {
				x,
				y: y + (h - height),
				width,
				height
			};
		});

		this.#addResizeHandle("bottom-left", (x, y, w, h, dx, dy, minW, minH) => ({
			x:      x + dx,
			y:      y,
			width:  Math.max(minW, w - dx),
			height: Math.max(minH, h + dy)
		}));

		this.#addResizeHandle("bottom-right", (x, y, w, h, dx, dy, minW, minH) => ({
			x:      x,
			y:      y,
			width:  Math.max(minW, w + dx),
			height:  Math.max(minH, h + dy)
		}));
	}

	/** Replace the AppWindow body with the given node. */
	setBody(node) {
		this.body_el.innerHTML = "";
		this.body_el.appendChild(node);
		return this;
	}

	/** Replace the AppWindow footer with the given node (e.g. a Cancel/Send button row). */
	setFooter(node) {
		this.footer_el.innerHTML = "";
		this.footer_el.appendChild(node);
		this.footer_el.style.display = "";
		return this;
	}

	setTitle(title) {
		this.title_el.textContent = title;
		return this;
	}
	
	getTitle() {
		return this.title_el.textContent;
	}

	#mount(parent = document.body) {
		parent.appendChild(this.hasBackdrop ? this.backdrop_el : this.el);
		return this;
	}

	setZIndex(zIndex) {
		this.el.style.zIndex = zIndex;
		this.zIndex = zIndex;

		if (this.hasBackdrop) {
			this.backdrop_el.style.zIndex = zIndex - 1;
		}
	}

	#setVisible(visible) {
		this.el.classList.toggle("AppWindow--open", visible);
		if (this.hasBackdrop) this.backdrop_el.classList.toggle("AppWindow-backdrop--open", visible);
	}
	#setEscapeEventListener() {
		if (this._onEscape) {
			document.removeEventListener("keydown", this._onEscape);
			document.addEventListener("keydown", this._onEscape);
		}
	}
	#removeEscapeEventListener() {
		if (this._onEscape) document.removeEventListener("keydown", this._onEscape);
	}

	open() {
		return this.#show();
	}

	#show() {
		this.#setVisible(true);
		this.#setEscapeEventListener();
		AppWindows.bringToFront(this);
		this.#setOpen();
		return this;
	}

	#minimize() {
		this.#setVisible(false);
		this.#removeEscapeEventListener();
		this.#setMinimized();
		return this;
    }

	toggle() {
		let activeWindow = AppWindows.getActiveWindow();
		if (activeWindow === this) {
			this.#minimize();
		} else {
			this.#show();
		}
		return this;
	}

	/** close */
	close() {
		this.#setVisible(false);
		this.#removeEscapeEventListener();
		this.#setClosed();
		return this;
	}

	destroy() {
		if (!this.canBeDestroyed) return false;
		//this.#setVisible(false); // better to not hide it as if something go wrong the window is just hidden, better to rely on actual remove
		this.#removeEscapeEventListener();
		(this.hasBackdrop ? this.backdrop_el : this.el).remove();
        AppWindows.removeFromList(this);
        AppWindows.emit('destroy', this);
        return true;
	}
}
