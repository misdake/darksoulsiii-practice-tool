import * as THREE from "three";
import { activeRegions } from "../geometry/region-geometry.js";
import { disposeObjectTree } from "../../../shared/map-runtime.js";
import {
  ACTIVE_COLOR,
  GROUPED_COLOR,
  REGION_COLOR,
  SELECTED_COLOR,
  createRegionOverlayObjects,
  createRegionVertexMarker,
} from "./region-overlay-meshes.js";
import { renderUncoveredPoints } from "./region-uncovered-renderer.js";

export class RegionOverlayController {
  constructor(scene) {
    this.regionGroup = new THREE.Group();
    this.vertexGroup = new THREE.Group();
    this.uncoveredGroup = new THREE.Group();
    this.selectedNavmeshGroup = new THREE.Group();
    this.active = [];
    this.activeSignature = "";

    scene.add(
      this.regionGroup,
      this.vertexGroup,
      this.uncoveredGroup,
      this.selectedNavmeshGroup,
    );
  }

  redraw({
    regions,
    selectedIndices = [],
    groupedIndices = [],
    primaryIndex = -1,
  }) {
    this.clearRegionOverlays();
    const selectedSet = new Set(selectedIndices);
    const groupedSet = new Set(groupedIndices);

    regions.forEach((region, index) => {
      if (region.polygon_xz.length < 3) {
        return;
      }

      this.addRegionOverlay(region, index, selectedSet, groupedSet);
      this.addVertexMarkers(region, index, primaryIndex);
    });
  }

  updateActive(regions, point, onChange) {
    this.active = activeRegions(regions, point);

    const signature = this.active.map((region) => region.name).join("\u0000");
    if (signature !== this.activeSignature) {
      this.activeSignature = signature;
      onChange?.(this.active);
    }

    return this.active;
  }

  renderUncovered(points) {
    renderUncoveredPoints(this.uncoveredGroup, points);
  }

  renderSelectedNavmeshes(meshes) {
    disposeObjectTree(this.selectedNavmeshGroup);
    for (const mesh of meshes || []) {
      if (!mesh?.isMesh || !mesh.geometry) {
        continue;
      }

      mesh.updateWorldMatrix(true, false);
      const outline = new THREE.LineSegments(
        new THREE.EdgesGeometry(mesh.geometry),
        new THREE.LineBasicMaterial({
          color: SELECTED_COLOR,
          depthTest: false,
          transparent: true,
          opacity: 0.95,
        }),
      );
      outline.matrix.copy(mesh.matrixWorld);
      outline.matrixAutoUpdate = false;
      outline.renderOrder = 1000;
      this.selectedNavmeshGroup.add(outline);
    }
  }

  dispose() {
    disposeObjectTree(this.regionGroup);
    disposeObjectTree(this.vertexGroup);
    disposeObjectTree(this.uncoveredGroup);
    disposeObjectTree(this.selectedNavmeshGroup);
  }

  clearRegionOverlays() {
    disposeObjectTree(this.regionGroup);
    disposeObjectTree(this.vertexGroup);
  }

  addRegionOverlay(region, index, selectedSet, groupedSet) {
    const color = this.regionColor(region, index, selectedSet, groupedSet);
    this.regionGroup.add(...createRegionOverlayObjects(region, color));
  }

  addVertexMarkers(region, regionIndex, selectedIndex) {
    if (regionIndex !== selectedIndex) {
      return;
    }
    for (const [vertexIndex, [x, z]] of region.polygon_xz.entries()) {
      this.vertexGroup.add(
        createRegionVertexMarker({
          x,
          z,
          y: region.ymin,
          regionIndex,
          vertexIndex,
          selected: regionIndex === selectedIndex,
        }),
      );
    }
  }

  regionColor(region, index, selectedSet, groupedSet) {
    if (selectedSet.has(index)) {
      return SELECTED_COLOR;
    }
    if (groupedSet.has(index)) {
      return GROUPED_COLOR;
    }
    return this.active.includes(region) ? ACTIVE_COLOR : REGION_COLOR;
  }
}
