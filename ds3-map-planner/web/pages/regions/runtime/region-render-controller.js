export class RegionRenderController {
  constructor({
    window,
    renderer,
    host,
    scene,
    leftCamera,
    rightCamera,
    viewportController,
    regionScene,
    onBeforeFrame,
    onBeforeRightRender,
    getFrameGamePosition,
    onFrameGamePosition,
    getFollowTarget,
  }) {
    this.window = window;
    this.renderer = renderer;
    this.host = host;
    this.scene = scene;
    this.leftCamera = leftCamera;
    this.rightCamera = rightCamera;
    this.viewportController = viewportController;
    this.regionScene = regionScene;
    this.onBeforeFrame = onBeforeFrame;
    this.onBeforeRightRender = onBeforeRightRender;
    this.getFrameGamePosition = getFrameGamePosition;
    this.onFrameGamePosition = onFrameGamePosition;
    this.getFollowTarget = getFollowTarget;
    this.animationFrame = 0;
    this.lastFrameTime = 0;
    this.stage = 4;
    this.resize = this.resize.bind(this);
    this.frame = this.frame.bind(this);
  }

  start() {
    this.window.addEventListener("resize", this.resize);
    this.resize();
    this.animationFrame = this.window.requestAnimationFrame(this.frame);
  }

  dispose() {
    this.window.removeEventListener("resize", this.resize);
    if (this.animationFrame) {
      this.window.cancelAnimationFrame(this.animationFrame);
      this.animationFrame = 0;
    }
  }

  resize() {
    this.renderer.setSize(this.host.clientWidth, this.host.clientHeight);
    const viewportAspect = this.host.clientWidth / 2 / this.host.clientHeight;
    this.viewportController.resizeLeftCamera(this.leftCamera, viewportAspect);
    this.rightCamera.aspect = viewportAspect;
    this.rightCamera.updateProjectionMatrix();
  }

  setStage(stage) {
    this.stage = Number(stage) || 4;
  }

  frame(now) {
    const dt = Math.min(
      0.05,
      (this.lastFrameTime ? now - this.lastFrameTime : 16) / 1000,
    );
    this.lastFrameTime = now;
    this.animationFrame = this.window.requestAnimationFrame(this.frame);

    if (this.stage !== 5) {
      this.viewportController.updateFreeCamera(dt);
    }
    this.onBeforeFrame?.(dt);
    const width = this.renderer.domElement.width;
    const height = this.renderer.domElement.height;
    const gamePosition = this.getFrameGamePosition();
    const activeRegions = this.onFrameGamePosition(gamePosition);

    const leftViewport = { x: 0, y: 0, width: width / 2, height };
    if (this.stage === 5) {
      this.viewportController.followLeftCameraTarget(
        this.leftCamera,
        this.getFollowTarget?.(),
      );
      this.regionScene.renderLeftMap(
        this.renderer,
        this.leftCamera,
        leftViewport,
        activeRegions,
      );
    } else {
      this.renderLeftScene(leftViewport);
    }

    this.renderer.setScissorTest(true);
    this.renderer.setViewport(width / 2, 0, width / 2, height);
    this.renderer.setScissor(width / 2, 0, width / 2, height);
    this.onBeforeRightRender?.();
    this.renderer.render(this.scene, this.rightCamera);
    this.renderer.setScissorTest(false);
  }

  renderLeftScene(viewport) {
    this.renderer.setScissorTest(true);
    this.renderer.setViewport(
      viewport.x,
      viewport.y,
      viewport.width,
      viewport.height,
    );
    this.renderer.setScissor(
      viewport.x,
      viewport.y,
      viewport.width,
      viewport.height,
    );
    this.renderer.setClearColor(0x10151d, 1);
    this.renderer.clear(true, true, true);
    this.renderer.render(this.scene, this.leftCamera);
  }
}
