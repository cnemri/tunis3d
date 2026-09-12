import * as THREE from 'three';
import { Atmosphere } from './sky.js';
import { World } from './world.js';
import { Navigator } from './controls.js';
import { Landmarks } from './landmarks.js';
import { UI } from './ui.js';
import { buildFacadeAtlas } from './facades.js';
import { lonLatToXZ } from './geo.js';

class App {
  constructor() {
    this.container = document.getElementById('app');
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', logarithmicDepthBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.8;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 1.0, 60000);
    this.clock = new THREE.Clock();

    // Uniforms shared between materials and the atmosphere.
    this.shared = {
      nightFactor: { value: 0 },
      sunDir: { value: new THREE.Vector3(0, 1, 0) },
      sunColor: { value: new THREE.Color(1, 1, 1) },
      facadeAtlas: buildFacadeAtlas(this.renderer),
    };

    this.atmosphere = new Atmosphere(this.scene, this.renderer);
    this.world = new World(this.scene, this.renderer, this.shared);
    this.landmarks = new Landmarks(this.scene);
    this.nav = new Navigator(this.camera, this.renderer.domElement, (x, z) => this.world.heightAt(x, z));
    this.ui = new UI(this);
    this.fps = 60;

    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  async start() {
    this.ui.setLoading('Loading terrain and water…', 0.05);
    await this.world.init((n) => this.ui.setLoading(`Loading water (${n})…`, 0.1 + Math.min(0.3, n / 200)));
    this.ui.setLoading('Placing monuments…', 0.5);
    await this.landmarks.init();
    this.ui.populateLandmarks(this.landmarks.list);
    this.ui.initMinimap(this.world.index.bbox);
    this.setHour(10.5);

    // Start above Avenue Habib Bourguiba looking west towards the Medina.
    const start = this.startFromHash() || { pos: lonLatToXZ(10.1925, 36.8005), target: lonLatToXZ(10.1712, 36.7975), alt: 140, targetAlt: 30 };
    const g = this.world.heightAt(start.pos[0], start.pos[1]);
    const tg = start.exact ? g : this.world.heightAt(start.target[0], start.target[1]);
    this.nav.teleport(
      new THREE.Vector3(start.pos[0], g + start.alt, start.pos[1]),
      new THREE.Vector3(start.target[0], tg + start.targetAlt, start.target[1]),
    );
    if (start.exact && start.alt < 3) this.nav.setMode('walk');
    this.ui.setLoading('Streaming buildings…', 0.7);
    this.world.update(this.camera, 0);
    // Give the first ring of chunks a moment to arrive before revealing.
    await new Promise((r) => setTimeout(r, 1500));
    this.ui.hideLoading();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // #lat,lon[,alt]            orbit-style view of a point from alt metres up
  // #lat,lon,alt,heading[,pitch] exact camera position, heading in degrees (0 = north)
  startFromHash() {
    const m = location.hash.match(/#(-?[\d.]+),(-?[\d.]+)(?:,(-?[\d.]+))?(?:,(-?[\d.]+))?(?:,(-?[\d.]+))?/);
    if (!m) return null;
    const lat = parseFloat(m[1]), lon = parseFloat(m[2]), alt = m[3] ? parseFloat(m[3]) : 120;
    const pos = lonLatToXZ(lon, lat);
    if (m[4] !== undefined) {
      const heading = (parseFloat(m[4]) * Math.PI) / 180;
      const pitch = m[5] !== undefined ? (parseFloat(m[5]) * Math.PI) / 180 : -0.05;
      const dir = [Math.sin(heading) * Math.cos(pitch), Math.sin(pitch), -Math.cos(heading) * Math.cos(pitch)];
      return { pos, target: [pos[0] + dir[0] * 100, pos[1] + dir[2] * 100], alt, targetAlt: alt + dir[1] * 100, exact: true };
    }
    return { pos: [pos[0] + 150, pos[1] + 150], target: pos, alt, targetAlt: 10 };
  }

  setHour(h) {
    this.atmosphere.setHour(h);
    this.shared.nightFactor.value = this.atmosphere.nightFactor;
    this.shared.sunDir.value.copy(this.atmosphere.sunDir);
    this.shared.sunColor.value.copy(this.atmosphere.sun.color);
    this.world.waterMaterial.uniforms.skyColor.value.copy(this.scene.fog.color).lerp(new THREE.Color(0x6f9ccf), 0.5);
  }

  setShadows(on) {
    this.renderer.shadowMap.enabled = on;
    this.atmosphere.sun.castShadow = on;
    this.scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
  }

  gotoLandmark(id) {
    const lm = this.landmarks.list.find((l) => l.id === id);
    if (!lm) return;
    const [x, z] = lm.pitch ? lm.pitch.center : lm.center;
    const ground = lm.ground;
    const h = lm.params?.height || lm.params?.minaret_h || lm.params?.tower_h || lm.osm_height || 20;
    let extent = 0;
    if (lm.footprint) {
      let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
      for (const [fx, fz] of lm.footprint) { minx = Math.min(minx, fx); maxx = Math.max(maxx, fx); minz = Math.min(minz, fz); maxz = Math.max(maxz, fz); }
      extent = Math.max(maxx - minx, maxz - minz);
    }
    const dist = Math.max(90, h * 2.6, extent * 0.8);
    // approach from the south-east, looking down slightly
    const pos = new THREE.Vector3(x + dist * 0.7, ground + h * 0.9 + dist * 0.45, z + dist * 0.7);
    this.nav.setMode('fly');
    this.nav.teleport(pos, new THREE.Vector3(x, ground + h * 0.5, z));
    location.hash = `${lm.lonlat[1].toFixed(5)},${lm.lonlat[0].toFixed(5)}`;
  }

  overview() {
    const [x, z] = lonLatToXZ(10.23, 36.72);
    const [tx, tz] = lonLatToXZ(10.20, 36.82);
    this.nav.setMode('fly');
    this.nav.teleport(new THREE.Vector3(x, 3200, z), new THREE.Vector3(tx, 0, tz));
  }

  // Debug helper: what is under screen pixel (px, py)?
  pick(px, py) {
    const ndc = new THREE.Vector2((px / window.innerWidth) * 2 - 1, -(py / window.innerHeight) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.camera);
    const hits = rc.intersectObjects(this.scene.children, true).filter((h) => h.object.name !== 'sky');
    return hits.slice(0, 3).map((h) => ({
      name: h.object.name, parent: h.object.parent?.name, type: h.object.type, dist: Math.round(h.distance),
      point: h.point.toArray().map((v) => Math.round(v)), material: h.object.material?.type,
      color: h.object.material?.color?.getHexString?.(), geoCount: h.object.geometry?.attributes?.position?.count,
    }));
  }

  frame() {
    const dt = this.clock.getDelta();
    const t = this.clock.elapsedTime;
    this.fps = this.fps * 0.95 + (1 / Math.max(dt, 1e-3)) * 0.05;
    this.nav.update(dt);
    this.world.update(this.camera, t);
    this.atmosphere.update(this.camera);
    this.ui.update(t, this.fps);
    this.renderer.render(this.scene, this.camera);
  }
}

const app = new App();
window.app = app;
app.start().catch((err) => {
  console.error(err);
  document.getElementById('loading-status').textContent = `Failed to start: ${err.message}`;
});
