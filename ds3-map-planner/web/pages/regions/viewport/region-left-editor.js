import * as THREE from "three";
import { closestPolygonEdgeInsertion } from "../geometry/region-geometry.js";

const EDIT_VERTEX_PICK_RADIUS_SQ = 4;

export class LeftRegionEditor {
  constructor({
    leftCamera,
    raycaster,
    vertexGroup,
    getSelectedRegion,
    getSelectedIndex,
    isEditing,
    onChange,
    onInvalid,
  }) {
    this.leftCamera = leftCamera;
    this.raycaster = raycaster;
    this.vertexGroup = vertexGroup;
    this.getSelectedRegion = getSelectedRegion;
    this.getSelectedIndex = getSelectedIndex;
    this.isEditing = isEditing;
    this.onChange = onChange;
    this.onInvalid = onInvalid;
    this.drag = null;
    this.beforeDragPolygon = null;
  }

  handlers() {
    return {
      onPointerDown: ({ ndc, event }) => this.pointerDown(ndc, event),
      onPointerMove: ({ ndc }) => this.pointerMove(ndc),
      onPointerUp: () => this.pointerUp(),
    };
  }

  pointerDown(ndc, event) {
    if (!this.isEditing?.()) {
      return;
    }
    this.raycaster.setFromCamera(ndc, this.leftCamera);

    const vertexHit = this.pickVertex();
    if (vertexHit) {
      event.preventDefault();
      this.startVertexEdit(vertexHit.object.userData, event);
      return;
    }

    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    this.tryInsertVertex();
  }

  pointerMove(ndc) {
    if (!this.isEditing?.() || !this.drag) {
      return;
    }

    const region = this.getSelectedRegion(this.drag.regionIndex);
    if (!region) {
      return;
    }

    this.raycaster.setFromCamera(ndc, this.leftCamera);
    const point = intersectRegionEditPlane(this.raycaster, region);
    if (!point) {
      return;
    }

    region.polygon_xz[this.drag.vertexIndex] = [point.x, point.z];
    this.onChange();
  }

  pointerUp() {
    if (
      this.drag &&
      this.onInvalid?.(
        this.getSelectedRegion(this.drag.regionIndex),
        this.beforeDragPolygon,
      )
    ) {
      this.onChange();
    }

    this.drag = null;
    this.beforeDragPolygon = null;
  }

  pickVertex() {
    return this.raycaster.intersectObjects(this.vertexGroup.children).at(0);
  }

  startVertexEdit(vertex, event) {
    const region = this.getSelectedRegion(vertex.regionIndex);
    if (!region) {
      return;
    }

    if (event.button === 2 && region.polygon_xz.length > 3) {
      region.polygon_xz.splice(vertex.vertexIndex, 1);
      this.onChange();
      return;
    }

    if (event.button !== 0) {
      return;
    }

    this.beforeDragPolygon = clonePolygon(region.polygon_xz);
    this.drag = vertex;
  }

  tryInsertVertex() {
    const region = this.getSelectedRegion();
    if (!region) {
      return;
    }

    const point = intersectRegionEditPlane(this.raycaster, region);
    if (!point) {
      return;
    }

    const insertion = closestPolygonEdgeInsertion(region.polygon_xz, [
      point.x,
      point.z,
    ]);
    if (insertion.distanceSq > EDIT_VERTEX_PICK_RADIUS_SQ) {
      return;
    }

    this.beforeDragPolygon = clonePolygon(region.polygon_xz);
    region.polygon_xz.splice(insertion.index, 0, [point.x, point.z]);
    this.drag = {
      regionIndex: this.getSelectedIndex(),
      vertexIndex: insertion.index,
    };
    this.onChange();
  }
}

function intersectRegionEditPlane(raycaster, region) {
  const point = new THREE.Vector3();
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -region.ymin);
  return raycaster.ray.intersectPlane(plane, point) ? point : null;
}

function clonePolygon(polygon) {
  return polygon.map((point) => [...point]);
}
