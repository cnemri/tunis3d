import * as THREE from 'three';

// First-person navigation with two modes:
//   fly  - free 6-DoF flight, speed scales with altitude
//   walk - eye 1.7 m above the terrain, no vertical input
// Mouse look uses the pointer lock; when unlocked, dragging also looks around.
export class Navigator {
  constructor(camera, domElement, heightAt) {
    this.camera = camera;
    this.dom = domElement;
    this.heightAt = heightAt;
    this.mode = 'fly';
    this.yaw = 0;
    this.pitch = -0.2;
    this.keys = new Set();
    this.velocity = new THREE.Vector3();
    this.locked = false;
    this.dragging = false;
    this.enabled = true;
    this.onModeChange = null;

    domElement.addEventListener('click', () => {
      if (!this.locked && this.enabled) domElement.requestPointerLock?.();
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === domElement;
    });
    domElement.addEventListener('mousedown', (e) => {
      if (e.button === 0) this.dragging = true;
    });
    window.addEventListener('mouseup', () => (this.dragging = false));
    window.addEventListener('mousemove', (e) => {
      if (!this.enabled) return;
      if (this.locked || this.dragging) {
        this.yaw -= e.movementX * 0.0022;
        this.pitch -= e.movementY * 0.0022;
        this.pitch = THREE.MathUtils.clamp(this.pitch, -Math.PI / 2 + 0.02, Math.PI / 2 - 0.02);
      }
    });
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      this.keys.add(e.code);
      if (e.code === 'KeyF') this.setMode(this.mode === 'fly' ? 'walk' : 'fly');
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    domElement.addEventListener(
      'wheel',
      (e) => {
        if (this.mode !== 'fly') return;
        // wheel = dolly along the view direction
        const dir = this.forward();
        this.camera.position.addScaledVector(dir, -e.deltaY * this.speedScale() * 0.02);
        e.preventDefault();
      },
      { passive: false },
    );
  }

  setMode(mode) {
    this.mode = mode;
    if (mode === 'walk') {
      const g = this.heightAt(this.camera.position.x, this.camera.position.z);
      this.camera.position.y = g + 1.7;
      this.velocity.set(0, 0, 0);
    }
    this.onModeChange?.(mode);
  }

  forward() {
    return new THREE.Vector3(
      -Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * Math.cos(this.pitch),
    );
  }

  lookAt(target) {
    const d = new THREE.Vector3().subVectors(target, this.camera.position);
    this.yaw = Math.atan2(-d.x, -d.z);
    this.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
  }

  teleport(pos, target) {
    this.camera.position.copy(pos);
    if (target) this.lookAt(target);
    this.velocity.set(0, 0, 0);
  }

  speedScale() {
    const alt = Math.max(0, this.camera.position.y - this.heightAt(this.camera.position.x, this.camera.position.z));
    return this.mode === 'walk' ? 1.6 : 12 + alt * 0.5;
  }

  update(dt) {
    dt = Math.min(dt, 0.1);
    const k = this.keys;
    const fwd = this.forward();
    const flat = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const move = new THREE.Vector3();
    const dirF = this.mode === 'walk' ? flat : fwd;
    if (k.has('KeyW') || k.has('ArrowUp')) move.add(dirF);
    if (k.has('KeyS') || k.has('ArrowDown')) move.sub(dirF);
    if (k.has('KeyD') || k.has('ArrowRight')) move.add(right);
    if (k.has('KeyA') || k.has('ArrowLeft')) move.sub(right);
    if (this.mode === 'fly') {
      if (k.has('Space') || k.has('KeyE')) move.y += 1;
      if (k.has('KeyC') || k.has('KeyQ')) move.y -= 1;
    }
    let speed = this.speedScale();
    if (k.has('ShiftLeft') || k.has('ShiftRight')) speed *= this.mode === 'walk' ? 2.5 : 4;
    if (k.has('AltLeft')) speed *= 0.25;
    if (move.lengthSq() > 0) move.normalize().multiplyScalar(speed);
    // smooth acceleration
    const accel = this.mode === 'walk' ? 12 : 5;
    this.velocity.lerp(move, 1 - Math.exp(-accel * dt));
    this.camera.position.addScaledVector(this.velocity, dt);

    const ground = this.heightAt(this.camera.position.x, this.camera.position.z);
    if (this.mode === 'walk') {
      this.camera.position.y = ground + 1.7;
    } else if (this.camera.position.y < ground + 2.0) {
      this.camera.position.y = ground + 2.0;
      this.velocity.y = Math.max(0, this.velocity.y);
    }
    this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
  }
}
