const POINTER_METHODS = {
  pointerdown: "onPointerDown",
  pointermove: "onPointerMove",
  pointerup: "onPointerUp",
  pointercancel: "onPointerUp",
  dblclick: "onDoubleClick",
  wheel: "onWheel",
};

const POINTER_EVENTS = Object.keys(POINTER_METHODS);

export class ViewportInputRouter {
  constructor(element, getLayout, environment = {}) {
    this.element = element;
    this.getLayout = getLayout;
    this.window = environment.window || globalThis.window;
    this.document = environment.document || globalThis.document;
    this.handlers = new Map();
    this.active = null;
    this.listeners = [];

    if (this.element.tabIndex < 0) {
      this.element.tabIndex = 0;
    }
    this.bindPointerEvents();
    this.addListener(this.window, "mousemove", (event) =>
      this.routePointerLockMove(event),
    );
    this.addListener(this.element, "keydown", (event) => {
      this.handlers.get(this.active)?.onKeyDown?.(event);
    });
    this.addListener(this.element, "keyup", (event) => {
      this.handlers.get(this.active)?.onKeyUp?.(event);
    });
    this.addListener(this.window, "blur", () => this.releasePointerLock());
  }

  register(name, handler) {
    this.handlers.set(name, handler);
    return () => this.handlers.delete(name);
  }

  dispose() {
    this.releasePointerLock();
    for (const { target, type, listener, options } of this.listeners) {
      target.removeEventListener(type, listener, options);
    }
    this.listeners = [];
    this.handlers.clear();
  }

  routePointer(type, event) {
    const rect = this.element.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const layout = this.getLayout(rect);
    const viewport = this.resolveViewport(type, layout, x, y, event);
    if (!viewport) {
      return;
    }

    if (type === "pointerdown") {
      this.active = viewport.name;
      this.element.focus?.({ preventScroll: true });
      this.element.setPointerCapture?.(event.pointerId);
      if (viewport.name !== "right") {
        this.releasePointerLock();
      }
    }

    this.handlers.get(viewport.name)?.[POINTER_METHODS[type]]?.({
      event,
      viewport,
      x: x - viewport.x,
      y: y - viewport.y,
      ndc: viewportNdc(viewport, x, y),
    });

    if (type === "pointerup" || type === "pointercancel") {
      this.element.releasePointerCapture?.(event.pointerId);
    }
  }

  routePointerLockMove(event) {
    if (this.document?.pointerLockElement !== this.element || !this.active) {
      return;
    }

    const rect = this.element.getBoundingClientRect();
    const viewport = this.getLayout(rect).find(
      (item) => item.name === this.active,
    );
    if (!viewport) {
      return;
    }

    this.handlers.get(viewport.name)?.onPointerMove?.({
      event,
      viewport,
      x: null,
      y: null,
      ndc: null,
    });
  }

  releasePointerLock() {
    if (this.document?.pointerLockElement === this.element) {
      this.document.exitPointerLock?.();
    }
  }

  requestPointerLock(viewportName) {
    if (viewportName !== "right") {
      return false;
    }

    this.element.requestPointerLock?.();
    return true;
  }

  bindPointerEvents() {
    for (const type of POINTER_EVENTS) {
      this.addListener(
        this.element,
        type,
        (event) => this.routePointer(type, event),
        { passive: type === "wheel" ? false : undefined },
      );
    }
  }

  addListener(target, type, listener, options) {
    if (!target) {
      return;
    }

    target.addEventListener(type, listener, options);
    this.listeners.push({ target, type, listener, options });
  }

  resolveViewport(type, layout, x, y, event = {}) {
    if (
      this.active &&
      (type === "pointermove" ||
        type === "pointerup" ||
        type === "pointercancel") &&
      (type !== "pointermove" || event.buttons)
    ) {
      const activeViewport = layout.find(
        (viewport) => viewport.name === this.active,
      );
      if (activeViewport) {
        return activeViewport;
      }
    }

    const underPointer = layout.find(
      (viewport) =>
        x >= viewport.x &&
        x < viewport.x + viewport.width &&
        y >= viewport.y &&
        y < viewport.y + viewport.height,
    );
    if (underPointer) {
      return underPointer;
    }

    if (type !== "pointerup" && type !== "pointercancel") {
      return null;
    }

    return layout.find((viewport) => viewport.name === this.active) || null;
  }
}

function viewportNdc(viewport, x, y) {
  return {
    x: ((x - viewport.x) / viewport.width) * 2 - 1,
    y: 1 - ((y - viewport.y) / viewport.height) * 2,
  };
}
