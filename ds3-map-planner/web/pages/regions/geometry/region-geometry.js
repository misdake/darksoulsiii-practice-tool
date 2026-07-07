export {
  gameToScene,
  sceneToGame,
} from "../../../shared/map-coordinate-transform.js";
export * from "./region-polygon-geometry.js";
export * from "./region-validation.js";
export * from "./region-coverage-geometry.js";

export function splitPrismHeight(prism) {
  const midpoint = (prism.ymin + prism.ymax) / 2;
  const lower = {
    ...prism,
    ymax: midpoint,
    polygon_xz: prism.polygon_xz.map(([x, z]) => [x, z]),
  };
  const upper = {
    ...prism,
    ymin: midpoint,
    polygon_xz: prism.polygon_xz.map(([x, z]) => [x, z]),
  };
  return { lower, upper };
}

export const splitRegionHeight = splitPrismHeight;
