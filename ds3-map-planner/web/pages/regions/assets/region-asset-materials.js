import * as THREE from "three";

export function createRegionNavmeshMaterial() {
  return new THREE.MeshStandardMaterial({
    color: 0x4ade80,
    roughness: 0.7,
    metalness: 0.0,
    transparent: false,
    opacity: 1,
    side: THREE.DoubleSide,
    shadowSide: THREE.DoubleSide,
  });
}

export function createHeightBandNavmeshMaterial(yMin, yMax) {
  const material = createRegionNavmeshMaterial();
  material.userData.heightBand = { yMin, yMax };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.regionYMin = { value: yMin };
    shader.uniforms.regionYMax = { value: yMax };
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        [
          "#include <common>",
          "varying float vRegionWorldY;",
        ].join("\n"),
      )
      .replace(
        "#include <begin_vertex>",
        [
          "#include <begin_vertex>",
          "vRegionWorldY = (modelMatrix * vec4(transformed, 1.0)).y;",
        ].join("\n"),
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        [
          "#include <common>",
          "uniform float regionYMin;",
          "uniform float regionYMax;",
          "varying float vRegionWorldY;",
        ].join("\n"),
      )
      .replace(
        "#include <color_fragment>",
        [
          "#include <color_fragment>",
          "float regionYRange = max(regionYMax - regionYMin, 0.0001);",
          "float rawRegionT = (vRegionWorldY - regionYMin) / regionYRange;",
          "float regionT = fract(rawRegionT * 2.0);",
          "vec3 lowColor = vec3(0.11, 0.64, 0.95);",
          "vec3 midColor = vec3(0.30, 0.95, 0.52);",
          "vec3 highColor = vec3(1.0, 0.78, 0.22);",
          "vec3 regionColor;",
          "if (regionT < 0.333333) {",
          "  float colorT = smoothstep(0.0, 0.333333, regionT);",
          "  regionColor = mix(lowColor, midColor, colorT);",
          "} else if (regionT < 0.666667) {",
          "  float colorT = smoothstep(0.333333, 0.666667, regionT);",
          "  regionColor = mix(midColor, highColor, colorT);",
          "} else {",
          "  float colorT = smoothstep(0.666667, 1.0, regionT);",
          "  regionColor = mix(highColor, lowColor, colorT);",
          "}",
          "diffuseColor.rgb = regionColor;",
        ].join("\n"),
      );
  };
  material.needsUpdate = true;
  return material;
}

export function createRegionCollisionMaterial() {
  return new THREE.MeshStandardMaterial({
    color: 0x94a3b8,
    roughness: 0.7,
    metalness: 0.0,
    transparent: true,
    opacity: 0.24,
    side: THREE.DoubleSide,
    shadowSide: THREE.DoubleSide,
  });
}
