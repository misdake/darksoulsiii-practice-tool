import { ViewportInputRouter } from "../../../shared/viewport-input-router.js";
import { LeftRegionEditor } from "./region-left-editor.js";
import { RightRegionViewport } from "./region-right-viewport.js";

const LEFT_ZOOM_IN = 0.88;
const LEFT_ZOOM_OUT = 1.12;
const LEFT_DEFAULT_HALF_HEIGHT = 20;

export class RegionViewportController {
  constructor(rightCamera) {
    this.rightViewport = new RightRegionViewport(rightCamera);
    this.leftPan = null;
  }

  focusRegion(region, leftCamera, { focusRight = true, aspect = 1 } = {}) {
    if (!region) return;

    const center = regionCenterScene(region);
    leftCamera.position.set(center.x, 100, center.z);
    leftCamera.lookAt(center.x, 0, center.z);
    const bounds = regionBoundsXZ(region);
    const halfHeight = Math.max(
      LEFT_DEFAULT_HALF_HEIGHT,
      (bounds.maxZ - bounds.minZ) / 2,
      (bounds.maxX - bounds.minX) / 2 / Math.max(1e-6, aspect),
    );
    setOrthographicHalfHeight(leftCamera, halfHeight * 1.18, aspect);

    if (focusRight) {
      this.rightViewport.focus(center, region);
    }
  }

  focusPoint(point, leftCamera) {
    if (!point) return;
    const center = { x: point[0], y: point[1], z: point[2] };
    leftCamera.position.set(center.x, 100, center.z);
    leftCamera.lookAt(center.x, 0, center.z);
    this.rightViewport.focus(center, {
      ymin: point[1] - 1.5,
      ymax: point[1] + 1.5,
      polygon_xz: [
        [point[0] - 2, point[2] - 2],
        [point[0] + 2, point[2] - 2],
        [point[0] + 2, point[2] + 2],
        [point[0] - 2, point[2] + 2],
      ],
    });
  }

  focusBounds(bounds, leftCamera, { aspect = 1, focusRight = true } = {}) {
    if (!bounds || bounds.isEmpty()) return;
    const center = {
      x: (bounds.min.x + bounds.max.x) / 2,
      y: (bounds.min.y + bounds.max.y) / 2,
      z: (bounds.min.z + bounds.max.z) / 2,
    };
    const size = {
      x: bounds.max.x - bounds.min.x,
      y: bounds.max.y - bounds.min.y,
      z: bounds.max.z - bounds.min.z,
    };
    const halfHeight = Math.max(
      LEFT_DEFAULT_HALF_HEIGHT,
      size.z / 2,
      size.x / 2 / Math.max(1e-6, aspect),
    );

    leftCamera.position.set(center.x, 100, center.z);
    leftCamera.lookAt(center.x, 0, center.z);
    setOrthographicHalfHeight(leftCamera, halfHeight * 1.12, aspect);
    if (focusRight) {
      this.rightViewport.focusBounds(center, Math.max(size.x, size.y, size.z));
    }
  }

  resizeLeftCamera(leftCamera, aspect) {
    resizeOrthographicCamera(leftCamera, aspect);
  }

  followLeftCameraTarget(leftCamera, target) {
    if (!target) return;
    leftCamera.position.x = target.x;
    leftCamera.position.z = target.z;
    leftCamera.lookAt(target.x, 0, target.z);
    leftCamera.updateMatrixWorld();
  }

  createInputRouter({
    element,
    document,
    leftCamera,
    raycaster,
    overlay,
    navGroup,
    getSelectedRegion,
    getSelectedIndex,
    isEditing,
    onChange,
    onInvalid,
    onRegion,
    onStage6Region,
    onNav,
    onEmpty,
    getSelectionMode,
    getStage,
    stage5Handlers,
  }) {
    const router = new ViewportInputRouter(element, splitRegionViewports, {
      document,
      window: document.defaultView,
    });
    const leftEditor = new LeftRegionEditor({
      leftCamera,
      raycaster,
      vertexGroup: overlay.vertexGroup,
      getSelectedRegion,
      getSelectedIndex,
      isEditing,
      onChange,
      onInvalid,
    });

    const leftEditorHandlers = leftEditor.handlers();
    router.register("left", {
      ...leftEditorHandlers,
      onPointerDown: (payload) => {
        const stage = getStage?.();
        if (stage === 5) {
          return;
        }
        if (stage === 4) {
          leftEditorHandlers.onPointerDown?.(payload);
        }
        if (payload.event.defaultPrevented || payload.event.button !== 2) {
          return;
        }
        payload.event.preventDefault();
        this.leftPan = {
          x: payload.event.clientX,
          y: payload.event.clientY,
        };
      },
      onPointerMove: (payload) => {
        const stage = getStage?.();
        if (stage === 5) {
          return;
        }
        if (this.leftPan) {
          const dx = payload.event.clientX - this.leftPan.x;
          const dy = payload.event.clientY - this.leftPan.y;
          this.leftPan.x = payload.event.clientX;
          this.leftPan.y = payload.event.clientY;
          panOrthographicCamera(leftCamera, dx, dy, payload.viewport.height);
          payload.event.preventDefault();
          return;
        }
        if (stage === 4) {
          leftEditorHandlers.onPointerMove?.(payload);
        }
      },
      onPointerUp: (payload) => {
        const stage = getStage?.();
        if (stage === 5) {
          this.leftPan = null;
          return;
        }
        if (this.leftPan) {
          this.leftPan = null;
          payload.event.preventDefault();
          return;
        }
        if (stage === 4) {
          leftEditorHandlers.onPointerUp?.(payload);
        }
      },
      onWheel: ({ event }) => {
        event.preventDefault();
        zoomOrthographicCamera(leftCamera, event.deltaY);
      },
    });

    const stage4Handlers = this.rightViewport.handlers({
        raycaster,
        vertexGroup: overlay.vertexGroup,
        regionGroup: overlay.regionGroup,
        navGroup,
        onRegion,
        onNav,
        onEmpty,
        getSelectionMode,
    });
    const stage6Handlers = this.rightViewport.handlers({
      raycaster,
      vertexGroup: overlay.vertexGroup,
      regionGroup: overlay.regionGroup,
      navGroup,
      onRegion: onStage6Region,
      onNav: () => {},
      onEmpty: () => onStage6Region?.(-1, { focusRight: false }),
      getSelectionMode: () => "region",
    });
    router.register(
      "right",
      dispatchByStage(getStage, { 4: stage4Handlers, 5: stage5Handlers, 6: stage6Handlers }),
    );

    return router;
  }

  updateFreeCamera(dt) {
    this.rightViewport.update(dt);
  }
}

function dispatchByStage(getStage, handlersByStage) {
  const out = {};
  for (const name of [
    "onPointerDown",
    "onPointerMove",
    "onPointerUp",
    "onWheel",
    "onKeyDown",
    "onKeyUp",
  ]) {
    out[name] = (payload) => {
      const handler = handlersByStage[Number(getStage?.()) || 4]?.[name];
      return handler?.(payload);
    };
  }
  return out;
}

function splitRegionViewports(rect) {
  return [
    { name: "left", x: 0, y: 0, width: rect.width / 2, height: rect.height },
    {
      name: "right",
      x: rect.width / 2,
      y: 0,
      width: rect.width / 2,
      height: rect.height,
    },
  ];
}

function regionCenterScene(region) {
  const xs = region.polygon_xz.map(([x]) => x);
  const zs = region.polygon_xz.map(([, z]) => z);
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (region.ymin + region.ymax) / 2,
    z: (Math.min(...zs) + Math.max(...zs)) / 2,
  };
}

function regionBoundsXZ(region) {
  const xs = region.polygon_xz.map(([x]) => x);
  const zs = region.polygon_xz.map(([, z]) => z);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minZ: Math.min(...zs),
    maxZ: Math.max(...zs),
  };
}

function zoomOrthographicCamera(camera, deltaY) {
  const scale = deltaY > 0 ? LEFT_ZOOM_OUT : LEFT_ZOOM_IN;
  const halfHeight = orthographicHalfHeight(camera) * scale;
  const aspect = orthographicAspect(camera);
  setOrthographicHalfHeight(camera, halfHeight, aspect);
}

function panOrthographicCamera(camera, deltaX, deltaY, viewportHeight) {
  const unitsPerPixel =
    (orthographicHalfHeight(camera) * 2) / Math.max(1, viewportHeight);
  camera.position.x -= deltaX * unitsPerPixel;
  camera.position.z -= deltaY * unitsPerPixel;
}

function resizeOrthographicCamera(camera, aspect) {
  setOrthographicHalfHeight(camera, orthographicHalfHeight(camera), aspect);
}

function setOrthographicHalfHeight(camera, halfHeight, aspect) {
  const height = Math.max(1e-6, Number(halfHeight) || LEFT_DEFAULT_HALF_HEIGHT);
  const width = height * Math.max(1e-6, Number(aspect) || 1);
  camera.left = -width;
  camera.right = width;
  camera.top = height;
  camera.bottom = -height;
  camera.updateProjectionMatrix();
}

function orthographicHalfHeight(camera) {
  return Math.max(1e-6, (Math.abs(camera.top) + Math.abs(camera.bottom)) / 2);
}

function orthographicAspect(camera) {
  const halfHeight = orthographicHalfHeight(camera);
  const halfWidth = Math.max(
    1e-6,
    (Math.abs(camera.left) + Math.abs(camera.right)) / 2,
  );
  return halfWidth / halfHeight;
}
