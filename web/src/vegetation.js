import * as THREE from 'three';

// Instanced trees.  Unit geometry is 1 m tall; the instance scale sets height
// (y) and crown width (x/z).  Trunks are kept thin regardless of the crown.
// type 0 = broadleaf (ficus / eucalyptus), 1 = date palm, 2 = pine / cypress,
// 3 = olive.

function rngFor(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function jitterSphere(radius, detail, amount, seed, squash = 0.85) {
  const g = new THREE.IcosahedronGeometry(radius, detail);
  const p = g.attributes.position;
  // Displace along the normal with a smooth pseudo-noise so the crown is lumpy
  // rather than spiky.
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    // two octaves of smooth trig noise; no per-vertex randomness so that
    // neighbouring faces stay continuous and the crown reads as soft foliage
    const n1 = Math.sin(v.x * 4.1 + seed) * Math.cos(v.y * 3.7 - seed) * Math.sin(v.z * 3.3 + 2 * seed);
    const n2 = Math.sin(v.x * 9.3 - seed) * Math.sin(v.y * 8.1 + seed) * Math.cos(v.z * 7.7 - 2 * seed);
    const k = 1 + amount * (0.75 * n1 + 0.35 * n2);
    v.multiplyScalar(k);
    p.setXYZ(i, v.x, v.y * squash, v.z);
  }
  g.computeVertexNormals();
  return g;
}

// Concatenate geometries into one non-indexed geometry with material groups:
// group 0 = bark, group 1 = foliage, group 2 = palm frond.
function merge(parts) {
  const positions = [], normals = [], uvs = [], colors = [];
  const groups = [];
  let start = 0;
  for (const { geo, color, group } of parts) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    const p = g.attributes.position.array;
    const n = g.attributes.normal.array;
    const uv = g.attributes.uv ? g.attributes.uv.array : null;
    const count = p.length / 3;
    for (let i = 0; i < p.length; i++) { positions.push(p[i]); normals.push(n[i]); }
    for (let i = 0; i < count; i++) {
      colors.push(color.r, color.g, color.b);
      if (uv) uvs.push(uv[i * 2], uv[i * 2 + 1]);
      else uvs.push(0, 0);
    }
    groups.push({ start, count, materialIndex: group });
    start += count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  out.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  let last = null;
  for (const g of groups) {
    if (last && last.materialIndex === g.materialIndex) last.count += g.count;
    else { out.addGroup(g.start, g.count, g.materialIndex); last = out.groups[out.groups.length - 1]; }
  }
  return out;
}

function broadleaf() {
  const trunk = new THREE.CylinderGeometry(0.022, 0.034, 0.42, 7);
  trunk.translate(0, 0.21, 0);
  const c1 = jitterSphere(0.42, 2, 0.16, 11, 0.8);
  c1.translate(0, 0.66, 0);
  const c2 = jitterSphere(0.27, 1, 0.2, 23, 0.85);
  c2.translate(0.2, 0.58, 0.12);
  const c3 = jitterSphere(0.24, 1, 0.2, 37, 0.85);
  c3.translate(-0.18, 0.62, -0.14);
  return merge([
    { geo: trunk, color: new THREE.Color(0x6b5741), group: 0 },
    { geo: c1, color: new THREE.Color(0x467a33), group: 1 },
    { geo: c2, color: new THREE.Color(0x538a3c), group: 1 },
    { geo: c3, color: new THREE.Color(0x3c6c2d), group: 1 },
  ]);
}

function palm() {
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.028, 0.045, 0.8, 7);
  trunk.translate(0, 0.4, 0);
  parts.push({ geo: trunk, color: new THREE.Color(0x8a7355), group: 0 });
  const nF = 10;
  for (let i = 0; i < nF; i++) {
    const a = (i / nF) * Math.PI * 2 + (i % 2) * 0.25;
    const droop = 0.5 + (i % 3) * 0.18;
    const frond = new THREE.PlaneGeometry(0.16, 0.5, 1, 4);
    const p = frond.attributes.position;
    for (let k = 0; k < p.count; k++) {
      const y = p.getY(k) + 0.25; // 0..0.5 along the frond
      const t = y / 0.5;
      p.setX(k, p.getX(k) * (0.35 + 0.65 * Math.sin(Math.PI * Math.min(1, t * 1.1))));
      p.setY(k, y * Math.cos(droop * t * 1.5));
      p.setZ(k, -y * Math.sin(droop * t * 1.5) - t * t * 0.15);
    }
    frond.rotateX(-Math.PI / 2 + 0.5);
    frond.rotateY(a);
    frond.translate(0, 0.82, 0);
    frond.computeVertexNormals();
    parts.push({ geo: frond, color: new THREE.Color(i % 2 ? 0x3f7a2f : 0x4d8a38), group: 2 });
  }
  const crown = new THREE.SphereGeometry(0.06, 6, 5);
  crown.translate(0, 0.81, 0);
  parts.push({ geo: crown, color: new THREE.Color(0x6a5a3a), group: 0 });
  return merge(parts);
}

function pine() {
  const trunk = new THREE.CylinderGeometry(0.02, 0.035, 0.6, 6);
  trunk.translate(0, 0.3, 0);
  const c1 = jitterSphere(0.36, 2, 0.22, 5, 0.55);
  c1.translate(0, 0.78, 0);
  const c2 = jitterSphere(0.22, 1, 0.25, 9, 0.6);
  c2.translate(0.14, 0.9, -0.06);
  return merge([
    { geo: trunk, color: new THREE.Color(0x4f3d2c), group: 0 },
    { geo: c1, color: new THREE.Color(0x2e5a29), group: 1 },
    { geo: c2, color: new THREE.Color(0x376a30), group: 1 },
  ]);
}

function olive() {
  const trunk = new THREE.CylinderGeometry(0.03, 0.05, 0.4, 6);
  trunk.translate(0, 0.2, 0);
  const c1 = jitterSphere(0.42, 2, 0.22, 41, 0.75);
  c1.translate(0, 0.62, 0);
  return merge([
    { geo: trunk, color: new THREE.Color(0x6a5a44), group: 0 },
    { geo: c1, color: new THREE.Color(0x7d8f5f), group: 1 },
  ]);
}

// Foliage texture: leafy speckle with holes for an airy silhouette.
function leafTexture() {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  const rnd = rngFor(77);
  for (let i = 0; i < 2600; i++) {
    const x = rnd() * size, y = rnd() * size, r = 3 + rnd() * 7;
    const v = 150 + rnd() * 105;
    ctx.fillStyle = `rgb(${v * 0.8},${v},${v * 0.7})`;
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * 0.6, rnd() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 3);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

function frondTexture() {
  const w = 64, h = 256;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h); ctx.stroke();
  ctx.lineWidth = 2.2;
  for (let y = 8; y < h; y += 7) {
    const len = 8 + 22 * Math.sin(Math.PI * Math.min(1, (y / h) * 1.15));
    ctx.beginPath(); ctx.moveTo(w / 2, y); ctx.lineTo(w / 2 - len, y + 10); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(w / 2, y + 3); ctx.lineTo(w / 2 + len, y + 13); ctx.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

export class TreeFactory {
  constructor() {
    this.geometries = [broadleaf(), palm(), pine(), olive()];
    const leaf = leafTexture();
    this.bark = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 });
    this.foliage = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.9,
      map: leaf,
      alphaMap: leaf,
      alphaTest: 0.35,
      side: THREE.DoubleSide,
    });
    this.frond = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.85,
      alphaMap: frondTexture(),
      alphaTest: 0.4,
      side: THREE.DoubleSide,
    });
    this.materials = [this.bark, this.foliage, this.frond];
    this.dummy = new THREE.Object3D();
  }

  // pos: Float32Array xyz, type: Uint8Array, h: Float32Array (metres).
  build(pos, type, h) {
    const group = new THREE.Group();
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < type.length; i++) counts[type[i] & 3]++;
    const meshes = counts.map((n, t) => {
      if (!n) return null;
      const m = new THREE.InstancedMesh(this.geometries[t], this.materials, n);
      m.castShadow = true;
      m.receiveShadow = false;
      return m;
    });
    const cursor = [0, 0, 0, 0];
    const d = this.dummy;
    const tint = new THREE.Color();
    for (let i = 0; i < type.length; i++) {
      const t = type[i] & 3;
      const m = meshes[t];
      const height = h[i];
      // crown width relative to height per species
      const width = t === 1 ? height * 0.75 : t === 2 ? height * 0.7 : t === 3 ? height * 1.1 : height * 0.95;
      d.position.set(pos[i * 3], pos[i * 3 + 1] - 0.2, pos[i * 3 + 2]);
      d.rotation.set(0, (pos[i * 3] * 13.7 + pos[i * 3 + 2] * 7.3) % (Math.PI * 2), 0);
      d.scale.set(width, height, width);
      d.updateMatrix();
      // per-instance tint: brightness and a little yellow/blue hue drift
      const r1 = ((pos[i * 3] * 0.37 + pos[i * 3 + 2] * 0.91) % 1 + 1) % 1;
      const r2 = ((pos[i * 3] * 1.13 - pos[i * 3 + 2] * 0.29) % 1 + 1) % 1;
      const b = 0.82 + 0.36 * r1;
      tint.setRGB(b * (0.92 + 0.16 * r2), b, b * (1.06 - 0.14 * r2));
      m.setColorAt(cursor[t], tint);
      m.setMatrixAt(cursor[t]++, d.matrix);
    }
    for (const m of meshes) {
      if (m) {
        m.instanceMatrix.needsUpdate = true;
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
        m.computeBoundingSphere();
        group.add(m);
      }
    }
    return group;
  }
}
