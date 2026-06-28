import test from "node:test";
import assert from "node:assert/strict";
import { ViewportInputRouter } from "../shared/viewport-input-router.js";
import { LeftRegionEditor } from "../pages/regions/viewport/region-left-editor.js";

test("ViewportInputRouter routes split pointer, drag and keyboard events", () => {
  const element = createEventTarget({
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 100 }),
    setPointerCapture() {},
    releasePointerCapture() {},
  });
  const windowTarget = createEventTarget();
  const documentTarget = { pointerLockElement: null, exitPointerLock() {} };
  const calls = [];

  const router = new ViewportInputRouter(
    element,
    () => [
      { name: "left", x: 0, y: 0, width: 100, height: 100 },
      { name: "right", x: 100, y: 0, width: 100, height: 100 },
    ],
    { window: windowTarget, document: documentTarget },
  );

  router.register("left", {
    onPointerDown: ({ ndc }) => calls.push(["left-down", ndc.x]),
    onPointerMove: () => calls.push(["left-move"]),
    onKeyDown: (event) => calls.push(["left-key", event.code]),
  });
  router.register("right", {
    onPointerDown: ({ ndc }) => calls.push(["right-down", ndc.x]),
    onPointerMove: () => calls.push(["right-move"]),
    onPointerUp: () => calls.push(["right-up"]),
    onDoubleClick: () => calls.push(["right-double"]),
    onKeyDown: (event) => calls.push(["right-key", event.code]),
  });

  element.dispatch("pointerdown", pointerEvent({ clientX: 150, clientY: 50 }));
  element.dispatch("keydown", { code: "KeyW" });
  element.dispatch(
    "pointermove",
    pointerEvent({ clientX: 50, clientY: 50, buttons: 1 }),
  );
  element.dispatch("pointerup", pointerEvent({ clientX: 50, clientY: 50 }));
  element.dispatch("dblclick", pointerEvent({ clientX: 150, clientY: 50 }));
  element.dispatch("pointerdown", pointerEvent({ clientX: 50, clientY: 50 }));
  element.dispatch("keydown", { code: "KeyA" });

  assert.deepEqual(calls, [
    ["right-down", 0],
    ["right-key", "KeyW"],
    ["right-move"],
    ["right-up"],
    ["right-double"],
    ["left-down", 0],
    ["left-key", "KeyA"],
  ]);

  assert.equal(element.listenerCount(), 8);
  assert.equal(windowTarget.listenerCount(), 2);
  router.dispose();
  assert.equal(element.listenerCount(), 0);
  assert.equal(windowTarget.listenerCount(), 0);
});

test("ViewportInputRouter forwards locked mouse movement to active viewport", () => {
  const element = createEventTarget({
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    setPointerCapture() {},
    releasePointerCapture() {},
    requestPointerLock() {},
  });
  const windowTarget = createEventTarget();
  const documentTarget = { pointerLockElement: null, exitPointerLock() {} };
  const movement = [];
  const router = new ViewportInputRouter(
    element,
    (rect) => [
      { name: "right", x: 0, y: 0, width: rect.width, height: rect.height },
    ],
    { window: windowTarget, document: documentTarget },
  );

  router.register("right", {
    onPointerDown: () => router.requestPointerLock("right"),
    onPointerMove: ({ event }) => movement.push(event.movementX),
  });

  element.dispatch("pointerdown", pointerEvent({ clientX: 1, clientY: 1 }));
  documentTarget.pointerLockElement = element;
  windowTarget.dispatch("mousemove", { movementX: 7, movementY: 0 });

  assert.deepEqual(movement, [7]);
  router.dispose();
});

test("LeftRegionEditor validates and commits right-click vertex deletion", () => {
  const region = {
    polygon_xz: [[0, 0], [2, 0], [2, 2], [0, 2]],
  };
  let validated = false;
  let committed = false;
  const editor = new LeftRegionEditor({
    leftCamera: {},
    raycaster: {
      setFromCamera() {},
      intersectObjects: () => [
        { object: { userData: { regionIndex: 0, vertexIndex: 1 } } },
      ],
    },
    vertexGroup: { children: [] },
    getSelectedRegion: () => region,
    getSelectedIndex: () => 0,
    isEditing: () => true,
    onInvalid: (candidate, before) => {
      validated = true;
      candidate.polygon_xz = before;
    },
    onCommit: () => {
      committed = true;
    },
  });

  editor.pointerDown({}, { button: 2, preventDefault() {} });
  assert.equal(validated, true);
  assert.equal(committed, true);
  assert.equal(region.polygon_xz.length, 4);
});

function createEventTarget(extra = {}) {
  const listeners = new Map();
  return {
    ...extra,
    addEventListener(type, listener) {
      if (!listeners.has(type)) {
        listeners.set(type, new Set());
      }
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatch(type, event) {
      for (const listener of listeners.get(type) || []) {
        listener(event);
      }
    },
    listenerCount() {
      return Array.from(listeners.values()).reduce(
        (count, items) => count + items.size,
        0,
      );
    },
  };
}

function pointerEvent(overrides) {
  return {
    button: 0,
    buttons: 0,
    pointerId: 1,
    preventDefault() {},
    ...overrides,
  };
}
