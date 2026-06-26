import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSM } from "three/addons/csm/CSM.js";

export function createFilterSceneParts({ app, window }) {
  const renderer = createFilterRenderer({ app, window });
  const scene = createFilterScene();
  const camera = createFilterCamera(window);
  const controls = createFilterControls(camera, renderer.domElement);
  const root = new THREE.Group();

  scene.add(new THREE.AmbientLight(0xffffff, 0.8));
  const directionalLight = new THREE.DirectionalLight(0xffffff, 0.5);
  directionalLight.position.set(120, 220, 100);
  scene.add(directionalLight, root);

  const csm = createFilterCsm({ camera, scene });
  return {
    renderer,
    scene,
    camera,
    controls,
    root,
    csm,
    clock: new THREE.Clock(),
  };
}

function createFilterRenderer({ app, window }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  app.appendChild(renderer.domElement);
  return renderer;
}

function createFilterScene() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f1115);
  return scene;
}

function createFilterCamera(window) {
  const camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    1,
    3000,
  );
  camera.position.set(100, 80, 100);
  return camera;
}

function createFilterControls(camera, element) {
  const controls = new OrbitControls(camera, element);
  controls.enableDamping = true;
  controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
  controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
  controls.mouseButtons.MIDDLE = null;
  return controls;
}

function createFilterCsm({ camera, scene }) {
  return new CSM({
    camera,
    parent: scene,
    cascades: 4,
    maxFar: 2000,
    mode: "practical",
    shadowMapSize: 2048,
    lightDirection: new THREE.Vector3(-0.6, -1.0, -0.45).normalize(),
    lightIntensity: 1.0,
    lightNear: 1,
    lightFar: 2200,
    fade: true,
  });
}
