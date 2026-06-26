import * as THREE from "three";

export const SELECTED_COLOR = 0xfacc15;
export const ACTIVE_COLOR = 0x22d3ee;
export const REGION_COLOR = 0x38bdf8;
export const VERTEX_COLOR = 0x60a5fa;

export function createRegionOverlayObjects(region, color) {
  const geometry = createRegionGeometry(region);
  const fill = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.3,
      side: THREE.DoubleSide,
    }),
  );
  fill.userData.kind = "region-fill";
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry),
    new THREE.LineBasicMaterial({
      color,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 1,
    }),
  );
  edges.renderOrder = 1001;
  edges.userData.kind = "region-edge";
  return [fill, edges];
}

export function createRegionVertexMarker({
  x,
  z,
  y,
  regionIndex,
  vertexIndex,
  selected,
}) {
  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(0.5, 8, 6),
    new THREE.MeshBasicMaterial({
      color: selected ? SELECTED_COLOR : VERTEX_COLOR,
      depthTest: false,
      depthWrite: false,
    }),
  );

  marker.position.set(x, y, z);
  marker.userData = { regionIndex, vertexIndex };
  marker.renderOrder = 1002;
  return marker;
}

function createRegionGeometry(region) {
  const shape = new THREE.Shape(
    region.polygon_xz.map(([x, z]) => new THREE.Vector2(x, -z)),
  );
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: region.ymax - region.ymin,
    bevelEnabled: false,
  });

  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, region.ymin, 0);
  return geometry;
}
