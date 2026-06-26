import * as THREE from "three";
import {
  groupSplitsByLayer,
  occupancyBoundsFromTriangles,
} from "../geometry/region-geometry.js";

const DEFAULT_REGION_MIN = new THREE.Vector3(-5, 0, -5);
const DEFAULT_REGION_MAX = new THREE.Vector3(5, 0, 5);
const DEFAULT_REGION_HEIGHT = 3;
const DEFAULT_REGION_FLOOR_PADDING = 0.5;
const AUTO_REGION_Y_PRECISION = 100;

export function trianglesFromMesh(mesh) {
  const position = mesh.geometry.getAttribute("position");
  const index = mesh.geometry.index;
  const triangleCount = index ? index.count : position.count;
  const triangles = [];

  for (let offset = 0; offset + 2 < triangleCount; offset += 3) {
    triangles.push([
      meshVertexAt(position, index, offset),
      meshVertexAt(position, index, offset + 1),
      meshVertexAt(position, index, offset + 2),
    ]);
  }

  return triangles;
}

export function collectNavmeshTriangles(navGroup) {
  return navGroup.children.flatMap((mesh) => trianglesFromMesh(mesh));
}

export function collectNavmeshSplits(navGroup) {
  return navGroup.children
    .map((mesh) => ({
      key: navmeshSplitKey(mesh),
      triangles: trianglesFromMesh(mesh),
    }))
    .filter((split) => split.triangles.length > 0);
}

export function createRegionFromMesh(mesh, index) {
  return createRegionFromMeshes([mesh], index);
}

export function createRegionFromMeshes(meshes, index) {
  const bounds = meshesBoundsOrDefault(meshes);
  const ymin = roundAutoRegionY(bounds.min.y - DEFAULT_REGION_FLOOR_PADDING);
  const ymax = roundAutoRegionY(bounds.max.y + DEFAULT_REGION_HEIGHT);

  return {
    name: `Region ${index + 1}`,
    ymin,
    ymax,
    polygon_xz: boundsToGamePolygon(bounds),
  };
}

export function buildAutoRegions(navGroup) {
  const regions = [];
  const splits = collectNavmeshSplits(navGroup);
  const layers = groupSplitsByLayer(splits);

  for (const layer of layers) {
    const paddedYmin = roundAutoRegionY(
      layer.ymin - DEFAULT_REGION_FLOOR_PADDING,
    );
    const ymax = roundAutoRegionY(layer.ymax + DEFAULT_REGION_HEIGHT);
    const triangles = layer.members.flatMap((member) => member.triangles);
    const polygons = occupancyBoundsFromTriangles(triangles);

    for (const polygon_xz of polygons) {
      regions.push({
        name: `Auto region ${regions.length + 1}`,
        ymin: paddedYmin,
        ymax,
        polygon_xz,
      });
    }
  }

  return regions;
}

function meshVertexAt(position, index, offset) {
  const vertexIndex = index ? index.getX(offset) : offset;
  return [
    position.getX(vertexIndex),
    position.getY(vertexIndex),
    position.getZ(vertexIndex),
  ];
}

function navmeshSplitKey(mesh) {
  return `${mesh.userData.navPath}::${mesh.userData.segmentIndex}`;
}

function meshesBoundsOrDefault(meshes) {
  const bounds = new THREE.Box3();
  let hasBounds = false;
  for (const mesh of meshes || []) {
    if (!mesh?.isMesh) {
      continue;
    }
    mesh.updateWorldMatrix(true, false);
    const meshBounds = new THREE.Box3().setFromObject(mesh);
    if (meshBounds.isEmpty()) {
      continue;
    }
    bounds.union(meshBounds);
    hasBounds = true;
  }
  return hasBounds
    ? bounds
    : { min: DEFAULT_REGION_MIN, max: DEFAULT_REGION_MAX };
}

function boundsToGamePolygon({ min, max }) {
  return [
    [min.x, min.z],
    [max.x, min.z],
    [max.x, max.z],
    [min.x, max.z],
  ];
}

function roundAutoRegionY(y) {
  return Math.round(y * AUTO_REGION_Y_PRECISION) / AUTO_REGION_Y_PRECISION;
}
