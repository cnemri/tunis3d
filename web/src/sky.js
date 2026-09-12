import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

// Sun position for Tunis (36.8 N) on a given day-of-year and local solar hour.
function sunDirection(hour, dayOfYear = 160) {
  const lat = (36.8 * Math.PI) / 180;
  const decl = ((23.44 * Math.PI) / 180) * Math.sin(((2 * Math.PI) / 365) * (dayOfYear - 81));
  const ha = ((hour - 12) * 15 * Math.PI) / 180;
  const elev = Math.asin(Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(ha));
  const az = Math.atan2(
    -Math.sin(ha),
    Math.tan(decl) * Math.cos(lat) - Math.sin(lat) * Math.cos(ha),
  ); // 0 = south, positive = west... convert to scene (x east, z south)
  const cosE = Math.cos(elev);
  // az measured from south towards west: south = +z, west = -x
  return new THREE.Vector3(-Math.sin(az) * cosE, Math.sin(elev), Math.cos(az) * cosE).normalize();
}

export class Atmosphere {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.sky = new Sky();
    this.sky.scale.setScalar(200000);
    scene.add(this.sky);

    const u = this.sky.material.uniforms;
    u.turbidity.value = 4.5;
    u.rayleigh.value = 1.6;
    u.mieCoefficient.value = 0.004;
    u.mieDirectionalG.value = 0.85;

    this.sun = new THREE.DirectionalLight(0xffffff, 3.0);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    this.sun.shadow.camera.near = 10;
    this.sun.shadow.camera.far = 3000;
    this.sun.shadow.camera.left = -500;
    this.sun.shadow.camera.right = 500;
    this.sun.shadow.camera.top = 500;
    this.sun.shadow.camera.bottom = -500;
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xbfd4ff, 0x8a7a60, 1.1);
    scene.add(this.hemi);
    this.ambient = new THREE.AmbientLight(0xffffff, 0.15);
    scene.add(this.ambient);

    scene.fog = new THREE.FogExp2(0xcfd9e6, 0.00006);
    this.hour = 10.5;
    this.setHour(this.hour);
  }

  setHour(hour) {
    this.hour = hour;
    const dir = sunDirection(hour);
    this.sunDir = dir;
    this.sky.material.uniforms.sunPosition.value.copy(dir);
    const elev = Math.asin(dir.y);
    const day = THREE.MathUtils.smoothstep(elev, -0.05, 0.25);
    this.dayFactor = day;
    this.sun.intensity = 3.2 * day;
    // Warm sun near the horizon.
    const warm = new THREE.Color(0xffd9b0);
    const noon = new THREE.Color(0xfff5e6);
    this.sun.color.copy(noon).lerp(warm, 1 - THREE.MathUtils.smoothstep(elev, 0.05, 0.6));
    this.hemi.intensity = 0.25 + 0.9 * day;
    this.ambient.intensity = 0.05 + 0.12 * day;
    this.renderer.toneMappingExposure = 0.55 + 0.25 * day;
    const dusk = new THREE.Color(0x2b3550);
    const dayFog = new THREE.Color(0xd6dfe9);
    const sunsetFog = new THREE.Color(0xe8c9a8);
    const fogCol = dayFog.clone().lerp(sunsetFog, 1 - THREE.MathUtils.smoothstep(elev, 0.05, 0.5)).lerp(dusk, 1 - day);
    this.scene.fog.color.copy(fogCol);
    this.sky.material.uniforms.rayleigh.value = 1.2 + 2.5 * (1 - THREE.MathUtils.smoothstep(elev, 0.0, 0.5));
    this.nightFactor = 1 - day;
  }

  // Keep the shadow frustum centred on the camera.
  update(camera) {
    const t = this.sun.target.position;
    t.copy(camera.position);
    t.y = Math.max(0, t.y - 100);
    this.sun.position.copy(t).addScaledVector(this.sunDir, 1200);
    const alt = Math.max(0, camera.position.y);
    const size = THREE.MathUtils.clamp(300 + alt * 1.5, 300, 2500);
    const cam = this.sun.shadow.camera;
    if (Math.abs(cam.right - size) > 50) {
      cam.left = -size;
      cam.right = size;
      cam.top = size;
      cam.bottom = -size;
      cam.updateProjectionMatrix();
    }
  }
}
