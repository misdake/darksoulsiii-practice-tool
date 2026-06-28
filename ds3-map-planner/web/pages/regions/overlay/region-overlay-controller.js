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
    this.cameraPlanGroup = new THREE.Group();
    this.active = [];
    this.activeSignature = "";

    scene.add(
      this.regionGroup,
      this.vertexGroup,
      this.uncoveredGroup,
      this.selectedNavmeshGroup,
      this.cameraPlanGroup,
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

  redrawRegion({ region, index, selectedIndices = [], groupedIndices = [] }) {
    if (!region || index < 0) return;
    for (const object of [...this.regionGroup.children]) {
      if (object.userData?.regionIndex !== index) continue;
      this.regionGroup.remove(object);
      disposeObjectTree(object);
    }
    disposeObjectTree(this.vertexGroup);
    this.addRegionOverlay(
      region,
      index,
      new Set(selectedIndices),
      new Set(groupedIndices),
    );
    this.addVertexMarkers(region, index, index);
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

  renderCameraPlan(points = []) {
    disposeObjectTree(this.cameraPlanGroup);
    if (!points.length) return;

    const geometry = new THREE.SphereGeometry(0.35, 10, 8);
    const material = new THREE.MeshBasicMaterial({ vertexColors: true });
    const mesh = new THREE.InstancedMesh(geometry, material, points.length);
    const matrix = new THREE.Matrix4();
    for (const [index, point] of points.entries()) {
      matrix.makeTranslation(point.x, point.y, point.z);
      mesh.setMatrixAt(index, matrix);
      mesh.setColorAt(
        index,
        new THREE.Color(
          point.replenished ? 0x22d3ee : point.lowered ? 0xfacc15 : 0x4ade80,
        ),
      );
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.userData.kind = "camera-plan-points";
    this.cameraPlanGroup.add(mesh);
  }

  setCameraPlanVisible(visible) {
    this.cameraPlanGroup.visible = Boolean(visible);
  }

  dispose() {
    disposeObjectTree(this.regionGroup);
    disposeObjectTree(this.vertexGroup);
    disposeObjectTree(this.uncoveredGroup);
    disposeObjectTree(this.selectedNavmeshGroup);
    disposeObjectTree(this.cameraPlanGroup);
  }

  clearRegionOverlays() {
    disposeObjectTree(this.regionGroup);
    disposeObjectTree(this.vertexGroup);
  }

  addRegionOverlay(region, index, selectedSet, groupedSet) {
    const color = this.regionColor(region, index, selectedSet, groupedSet);
    const objects = createRegionOverlayObjects(region, color);
    for (const object of objects) object.userData.regionIndex = index;
    this.regionGroup.add(...objects);
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
