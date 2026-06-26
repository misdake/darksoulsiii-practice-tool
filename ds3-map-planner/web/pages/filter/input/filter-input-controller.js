import { ViewportInputRouter } from "../../../shared/viewport-input-router.js";

function isTextLikeInput(activeElement) {
  const tag = activeElement?.tagName?.toLowerCase() || "";
  const inputType =
    activeElement && tag === "input"
      ? String(activeElement.type || "").toLowerCase()
      : "";
  return (
    tag === "textarea" ||
    tag === "select" ||
    (tag === "input" &&
      (inputType === "text" ||
        inputType === "number" ||
        inputType === "search" ||
        inputType === "email" ||
        inputType === "url" ||
        inputType === "tel" ||
        inputType === "password"))
  );
}

export class FilterInputController {
  constructor({
    document,
    window,
    element,
    getStageConfig,
    buildStageContext,
    getPick,
    onSelectTarget,
    onResize,
  }) {
    this.document = document;
    this.window = window;
    this.element = element;
    this.getStageConfig = getStageConfig;
    this.buildStageContext = buildStageContext;
    this.getPick = getPick;
    this.onSelectTarget = onSelectTarget;
    this.onResize = onResize;
    this.pointerDown = false;
    this.pointerDownX = 0;
    this.pointerDownY = 0;
    this.suppressNextClick = false;
    this.resizeListener = null;
    this.router = null;
  }

  start() {
    this.router = new ViewportInputRouter(
      this.element,
      (rect) => [
        { name: "main", x: 0, y: 0, width: rect.width, height: rect.height },
      ],
      { document: this.document, window: this.window },
    );
    this.router.register("main", {
      onPointerDown: ({ event }) => this.onPointerDown(event),
      onPointerMove: ({ event }) => this.onPointerMove(event),
      onPointerUp: ({ event }) => this.onPointerUp(event),
      onWheel: ({ event }) => this.onWheel(event),
      onKeyDown: (event) => this.onKeyDown(event),
      onKeyUp: (event) => this.onKeyUp(event),
    });
    this.resizeListener = () => this.onResize();
    this.window.addEventListener("resize", this.resizeListener);
  }

  dispose() {
    this.router?.dispose();
    this.router = null;
    if (this.resizeListener) {
      this.window.removeEventListener("resize", this.resizeListener);
      this.resizeListener = null;
    }
  }

  onPointerDown(event) {
    if (this.getStageConfig().onPointerDown?.(this.buildStageContext(), event)) {
      event.preventDefault();
      return;
    }
    if (event.button === 1) return;
    this.pointerDown = true;
    this.pointerDownX = event.clientX;
    this.pointerDownY = event.clientY;
  }

  onPointerMove(event) {
    if (this.getStageConfig().onPointerMove?.(this.buildStageContext(), event)) {
      event.preventDefault();
    }
    if (!this.pointerDown) return;
    const dx = event.clientX - this.pointerDownX;
    const dy = event.clientY - this.pointerDownY;
    if (dx * dx + dy * dy > 16) this.suppressNextClick = true;
  }

  onPointerUp(event) {
    if (this.getStageConfig().onPointerUp?.(this.buildStageContext(), event)) {
      event.preventDefault();
    }
    const shouldClick = !this.suppressNextClick;
    this.pointerDown = false;
    this.suppressNextClick = false;
    if (!shouldClick || event.button !== 0) {
      return;
    }
    if (this.getStageConfig().onPointerClick?.(this.buildStageContext(), event)) {
      event.preventDefault();
      return;
    }
    this.onSelectTarget(this.getPick(event));
  }

  onWheel(event) {
    if (this.getStageConfig().onWheel?.(this.buildStageContext(), event)) {
      event.preventDefault();
    }
  }

  onKeyDown(event) {
    if (isTextLikeInput(this.document.activeElement)) return;
    if (this.getStageConfig().onKeyDown?.(this.buildStageContext(), event)) {
      event.preventDefault();
    }
  }

  onKeyUp(event) {
    this.getStageConfig().onKeyUp?.(this.buildStageContext(), event);
  }
}
