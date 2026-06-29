export {
  gameToScene,
  sceneToGame,
} from "../../../shared/map-coordinate-transform.js";
export * from "./region-polygon-geometry.js";
export * from "./region-validation.js";
export * from "./region-coverage-geometry.js";

export function splitRegionHeight(region, newName) {
  const midpoint = (region.ymin + region.ymax) / 2;
  const lower = {
    ...region,
    ymax: midpoint,
    polygon_xz: region.polygon_xz.map(([x, z]) => [x, z]),
  };
  const upper = {
    ...region,
    name: newName,
    ymin: midpoint,
    polygon_xz: region.polygon_xz.map(([x, z]) => [x, z]),
  };
  return { lower, upper };
}
