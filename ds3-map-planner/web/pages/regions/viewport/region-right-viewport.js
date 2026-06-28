import { RegionFreeCamera } from "./region-free-camera.js";

export class RightRegionViewport {
  constructor(camera) {
    this.camera = camera;
    this.freeCamera = new RegionFreeCamera(camera);
    this.pointerDown = false;
    this.pointerButton = -1;
    this.lastX = 0;
    this.lastY = 0;
    this.dragMoved = false;
  }

  focus(center, region) {
    this.freeCamera.focus(center, region);
  }

  focusBounds(center, radius) {
    this.freeCamera.focusBounds(center, radius);
  }

  handlers({
    raycaster,
    vertexGroup,
    regionGroup,
    navGroup,
    onRegion,
    onNav,
    onFocusRegion,
    onFocusNav,
    onEmpty,
    getSelectionMode,
  }) {
    return {
      onPointerDown: ({ ndc, event }) => {
        if (event.button === 1) return;
        event.preventDefault();
        this.pointerDown = true;
        this.pointerButton = event.button;
        this.lastX = event.clientX;
        this.lastY = event.clientY;
        this.dragMoved = false;
      },
      onPointerMove: ({ event, viewport }) => {
        if (!this.pointerDown) return;
        const dx = event.clientX - this.lastX;
        const dy = event.clientY - this.lastY;
        this.lastX = event.clientX;
        this.lastY = event.clientY;
        if (dx * dx + dy * dy > 0) {
          this.dragMoved = true;
        }
        if (!dx && !dy) return;
        event.preventDefault();
        if (this.pointerButton === 2) {
          this.freeCamera.pan(dx, dy, viewport.height);
        } else {
          this.freeCamera.rotate(dx, dy);
        }
      },
      onPointerUp: ({ ndc, event }) => {
        const shouldPick =
          this.pointerDown &&
          !this.dragMoved &&
          this.pointerButton === 0 &&
          event.button === 0;
        this.pointerDown = false;
        this.pointerButton = -1;
        if (!shouldPick) return;
        event.preventDefault();
        this.pick({
          ndc,
          raycaster,
          vertexGroup,
          regionGroup,
          navGroup,
          onRegion,
          onNav,
          onEmpty,
          getSelectionMode,
          event,
        });
      },
      onDoubleClick: ({ ndc, event }) => {
        event.preventDefault();
        this.focusPick({
          ndc,
          raycaster,
          vertexGroup,
          regionGroup,
          navGroup,
          onFocusRegion,
          onFocusNav,
          mode: getSelectionMode?.() === "navmesh" ? "navmesh" : "region",
        });
      },
      onWheel: ({ event }) => {
        event.preventDefault();
        this.freeCamera.zoom(event.deltaY);
      },
      onKeyDown: (event) => this.freeCamera.setKey(event.code, true),
      onKeyUp: (event) => this.freeCamera.setKey(event.code, false),
    };
  }

  update(dt) {
    this.freeCamera.update(dt);
  }

  pick({
    ndc,
    raycaster,
    vertexGroup,
    regionGroup,
    navGroup,
    onRegion,
    onNav,
    onEmpty,
    getSelectionMode,
    event,
  }) {
    raycaster.setFromCamera(ndc, this.camera);
    const mode = getSelectionMode?.() === "navmesh" ? "navmesh" : "region";

    if (mode === "region") {
      const vertex = raycaster
        .intersectObjects(vertexGroup.children, true)
        .at(0);
      if (vertex) {
        onRegion(vertex.object.userData.regionIndex, { focusRight: false });
        return true;
      }

      const regionIndex = pickRegionIndex(raycaster, regionGroup);
      if (regionIndex >= 0) {
        onRegion(regionIndex, {
          focusRight: false,
          toggle: event?.ctrlKey || event?.metaKey,
        });
        return true;
      }
    }

    if (mode === "navmesh") {
      const nav = raycaster.intersectObjects(navGroup.children, true).at(0);
      if (nav) {
        onNav(nav.object, { toggle: event?.ctrlKey || event?.metaKey });
        return true;
      }
    }

    onEmpty?.();
    return false;
  }

  focusPick({
    ndc,
    raycaster,
    vertexGroup,
    regionGroup,
    navGroup,
    onFocusRegion,
    onFocusNav,
    mode = "any",
  }) {
    raycaster.setFromCamera(ndc, this.camera);
    if (mode !== "navmesh") {
      const vertex = raycaster
        .intersectObjects(vertexGroup.children, true)
        .at(0);
      const regionIndex = vertex
        ? vertex.object.userData.regionIndex
        : pickRegionIndex(raycaster, regionGroup);
      if (regionIndex >= 0) {
        onFocusRegion?.(regionIndex);
        return true;
      }
    }

    if (mode !== "region") {
      const nav = raycaster.intersectObjects(navGroup.children, true).at(0);
      if (nav) {
        onFocusNav?.(nav.object);
        return true;
      }
    }
    return false;
  }
}

function pickRegionIndex(raycaster, regionGroup) {
  const hit = raycaster
    .intersectObjects(regionGroup.children, true)
    .find((item) => item.object.isMesh);
  if (!hit) return -1;
  return regionGroup.children.filter((item) => item.isMesh).indexOf(hit.object);
}
