import * as THREE from "three";
import { isObjectHierarchyVisible } from "../scene/filter-camera-fit.js";

export class FilterPickController {
  constructor({
    element,
    camera,
    root,
    getCollisionGroup,
    getNavmeshGroup,
    getStageConfig,
  }) {
    this.element = element;
    this.camera = camera;
    this.root = root;
    this.getCollisionGroup = getCollisionGroup;
    this.getNavmeshGroup = getNavmeshGroup;
    this.getStageConfig = getStageConfig;
    this.raycaster = new THREE.Raycaster();
    this.mouseNdc = new THREE.Vector2();
  }

  pick(event) {
    this.updatePointerNdc(event);
    this.raycaster.setFromCamera(this.mouseNdc, this.camera);

    const stageConfig = this.getStageConfig();
    const collisionGroup = this.getCollisionGroup();
    const navmeshGroup = this.getNavmeshGroup();
    const hits = this.raycaster.intersectObjects(this.root.children, true);

    for (const hit of hits) {
      const pickedRoot = this.findPickRoot(
        hit.object,
        collisionGroup,
        navmeshGroup,
      );
      if (!pickedRoot || !isObjectHierarchyVisible(hit.object)) continue;

      const picked = stageConfig.resolvePick(hit, pickedRoot);
      if (picked) return picked;
    }

    return null;
  }

  updatePointerNdc(event) {
    const rect = this.element.getBoundingClientRect();
    this.mouseNdc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
  }

  findPickRoot(object, collisionGroup, navmeshGroup) {
    if (!object || object.visible === false) return null;

    let node = object;
    while (
      node &&
      node.parent !== collisionGroup &&
      node.parent !== navmeshGroup
    ) {
      node = node.parent;
    }

    if (!node || !isObjectHierarchyVisible(node)) return null;
    return node;
  }
}
