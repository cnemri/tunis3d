import * as THREE from 'three';

// Procedural facade atlas: a 2D texture array with one layer per wall style.
// Each 512x512 layer covers two bays (6.4 m) by two floors (6.2 m).  RGB is
// the albedo (kept close to white so the per-building vertex colour tints it),
// alpha marks glass that glows at night.
export const STYLE = { BLANK: 0, RES: 1, OFFICE: 2, ARCH: 3, INDUSTRIAL: 4, GROUND: 5, MEDINA: 6 };
const SIZE = 512;
const LAYERS = 7;
const BAY_M = 6.4;
const FLOOR_M = 6.2;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function plaster(ctx, seed, base = [236, 232, 222]) {
  const r = rng(seed);
  ctx.fillStyle = `rgb(${base[0]},${base[1]},${base[2]})`;
  ctx.fillRect(0, 0, SIZE, SIZE);
  // grime / streaks
  for (let i = 0; i < 900; i++) {
    const x = r() * SIZE;
    const y = r() * SIZE;
    const a = 0.03 + r() * 0.05;
    const d = r() < 0.5 ? -1 : 1;
    ctx.fillStyle = `rgba(${d > 0 ? 255 : 60},${d > 0 ? 255 : 55},${d > 0 ? 250 : 45},${a})`;
    ctx.fillRect(x, y, 2 + r() * 10, 2 + r() * 40);
  }
  // darker foot of each floor (dirt line)
  for (let f = 0; f < 2; f++) {
    const y0 = SIZE - (f * SIZE) / 2;
    const g = ctx.createLinearGradient(0, y0 - 40, 0, y0);
    g.addColorStop(0, 'rgba(90,80,70,0)');
    g.addColorStop(1, 'rgba(90,80,70,0.18)');
    ctx.fillStyle = g;
    ctx.fillRect(0, y0 - 40, SIZE, 40);
  }
}

function frame(ctx, x, y, w, h, colour, t = 6) {
  ctx.fillStyle = colour;
  ctx.fillRect(x - t, y - t, w + 2 * t, h + 2 * t);
}

function glass(ctx, alpha, x, y, w, h, tint = [70, 90, 110]) {
  const g = ctx.createLinearGradient(x, y, x + w, y + h);
  g.addColorStop(0, `rgb(${tint[0] + 40},${tint[1] + 40},${tint[2] + 40})`);
  g.addColorStop(0.5, `rgb(${tint[0]},${tint[1]},${tint[2]})`);
  g.addColorStop(1, `rgb(${tint[0] - 30},${tint[1] - 30},${tint[2] - 20})`);
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  alpha.fillStyle = '#fff';
  alpha.fillRect(x, y, w, h);
}

function shutters(ctx, x, y, w, h, colour = '#2f5f9e') {
  ctx.fillStyle = colour;
  ctx.fillRect(x - w * 0.55, y, w * 0.5, h);
  ctx.fillRect(x + w + w * 0.05, y, w * 0.5, h);
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  for (let i = 0; i < 8; i++) {
    const yy = y + (i + 0.5) * (h / 8);
    ctx.fillRect(x - w * 0.55, yy, w * 0.5, 2);
    ctx.fillRect(x + w + w * 0.05, yy, w * 0.5, 2);
  }
}

function drawResidential(ctx, alpha, seed) {
  plaster(ctx, seed, [238, 234, 224]);
  const r = rng(seed + 7);
  for (let fy = 0; fy < 2; fy++) {
    for (let bx = 0; bx < 2; bx++) {
      const cx = bx * 256 + 128;
      const cy = fy * 256 + 128;
      const w = 64 + r() * 12;
      const h = 110 + r() * 20;
      const x = cx - w / 2;
      const y = cy - h / 2 - 10;
      frame(ctx, x, y, w, h, '#f4f2ee', 8);
      glass(ctx, alpha, x, y, w, h, [60, 80, 100]);
      // window bars
      ctx.fillStyle = '#e8e6e0';
      ctx.fillRect(x + w / 2 - 2, y, 4, h);
      ctx.fillRect(x, y + h * 0.45, w, 4);
      if (r() < 0.6) shutters(ctx, x, y, w, h, r() < 0.7 ? '#2f5f9e' : '#5a7f5a');
      // balcony slab / railing
      if (r() < 0.5) {
        ctx.fillStyle = '#d9d6cf';
        ctx.fillRect(x - 30, y + h + 6, w + 60, 10);
        ctx.fillStyle = '#3b4a5a';
        for (let i = 0; i < 12; i++) ctx.fillRect(x - 30 + i * ((w + 60) / 12), y + h - 40, 3, 46);
        ctx.fillRect(x - 30, y + h - 42, w + 60, 4);
      }
    }
  }
}

function drawOffice(ctx, alpha, seed) {
  const r = rng(seed);
  // Tunis office/hotel blocks: light concrete spandrels with a horizontal
  // window band per floor (two floors per tile, one band each so the floor
  // rhythm reads as ~3.1 m).
  plaster(ctx, seed, [214, 212, 205]);
  for (let fy = 0; fy < 2; fy++) {
    const y = fy * 256 + 58;
    const h = 130;
    glass(ctx, alpha, 0, y, SIZE, h, [96, 106, 116]);
    // mullions every half bay, slimmer secondary ones between
    ctx.fillStyle = '#c6c4bd';
    for (let i = 0; i <= 8; i++) ctx.fillRect(i * 64 - 3, y, 6, h);
    ctx.fillStyle = 'rgba(200,198,190,0.6)';
    for (let i = 0; i < 8; i++) ctx.fillRect(i * 64 + 30, y, 3, h);
    // sill and lintel shading
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    ctx.fillRect(0, y - 6, SIZE, 6);
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.fillRect(0, y + h, SIZE, 5);
    ctx.fillStyle = 'rgba(0,0,0,0.08)';
    ctx.fillRect(0, y + h + 5, SIZE, 10);
    // a few drawn blinds / reflections so the band isn't uniform
    for (let i = 0; i < 5; i++) {
      const x = Math.floor(r() * 8) * 64 + 3;
      ctx.fillStyle = `rgba(225,222,210,${0.35 + r() * 0.4})`;
      ctx.fillRect(x, y, 27, h * (0.3 + r() * 0.6));
    }
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = `rgba(255,255,255,${0.04 + r() * 0.06})`;
      ctx.fillRect(r() * SIZE, y, 20 + r() * 40, h);
    }
  }
}

function drawArch(ctx, alpha, seed) {
  plaster(ctx, seed, [228, 218, 198]);
  const r = rng(seed + 3);
  // stone courses
  ctx.fillStyle = 'rgba(120,100,80,0.18)';
  for (let y = 0; y < SIZE; y += 42) ctx.fillRect(0, y, SIZE, 2);
  for (let fy = 0; fy < 2; fy++) {
    for (let bx = 0; bx < 2; bx++) {
      const cx = bx * 256 + 128;
      const y = fy * 256 + 70;
      const w = 76;
      const h = 130;
      const x = cx - w / 2;
      ctx.fillStyle = '#d8c9ac';
      ctx.beginPath();
      ctx.moveTo(x - 10, y + h + 10);
      ctx.lineTo(x - 10, y + w / 2);
      ctx.arc(cx, y + w / 2 + 10, w / 2 + 10, Math.PI, 0);
      ctx.lineTo(x + w + 10, y + h + 10);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#3a4550';
      alpha.fillStyle = '#fff';
      for (const c of [ctx, alpha]) {
        c.beginPath();
        c.moveTo(x, y + h);
        c.lineTo(x, y + w / 2 + 10);
        c.arc(cx, y + w / 2 + 10, w / 2, Math.PI, 0);
        c.lineTo(x + w, y + h);
        c.closePath();
        c.fill();
      }
      // wooden lattice (moucharabieh feel)
      ctx.fillStyle = 'rgba(160,120,80,0.8)';
      for (let i = 1; i < 6; i++) ctx.fillRect(x + (i * w) / 6, y + 10, 2, h - 10);
      for (let i = 1; i < 8; i++) ctx.fillRect(x, y + 20 + (i * (h - 20)) / 8, w, 2);
      if (r() < 0.4) {
        // horseshoe accent stripes
        ctx.fillStyle = 'rgba(180,150,100,0.35)';
        ctx.fillRect(x - 10, y + h + 10, w + 20, 6);
      }
    }
  }
}

function drawIndustrial(ctx, alpha, seed) {
  const r = rng(seed);
  ctx.fillStyle = '#c4c2bc';
  ctx.fillRect(0, 0, SIZE, SIZE);
  // corrugated panels
  for (let x = 0; x < SIZE; x += 8) {
    ctx.fillStyle = x % 16 === 0 ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.12)';
    ctx.fillRect(x, 0, 4, SIZE);
  }
  // rust streaks
  for (let i = 0; i < 60; i++) {
    ctx.fillStyle = `rgba(120,70,40,${0.05 + r() * 0.12})`;
    ctx.fillRect(r() * SIZE, r() * SIZE, 4, 30 + r() * 120);
  }
  // high strip windows
  for (let fy = 0; fy < 2; fy++) {
    const y = fy * 256 + 30;
    glass(ctx, alpha, 20, y, SIZE - 40, 50, [90, 100, 105]);
    ctx.fillStyle = '#8a8a86';
    for (let i = 0; i <= 12; i++) ctx.fillRect(20 + i * ((SIZE - 40) / 12) - 1, y, 3, 50);
  }
}

function drawGround(ctx, alpha, seed) {
  plaster(ctx, seed, [232, 226, 214]);
  const r = rng(seed + 11);
  for (let bx = 0; bx < 2; bx++) {
    const x0 = bx * 256;
    // lower half of the layer = street level floor
    const y = 256 + 40;
    const kind = r();
    if (kind < 0.45) {
      // shopfront with awning
      const w = 200;
      const x = x0 + 28;
      frame(ctx, x, y, w, 190, '#5a4a3a', 8);
      glass(ctx, alpha, x, y, w, 190, [55, 65, 75]);
      ctx.fillStyle = ['#b03a2e', '#2f5f9e', '#d9a441', '#3d7a4a'][Math.floor(r() * 4)];
      ctx.fillRect(x - 20, y - 30, w + 40, 34);
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fillRect(x - 20, y + 2, w + 40, 8);
    } else if (kind < 0.8) {
      // arched blue door + small window
      const cx = x0 + 96;
      ctx.fillStyle = '#e0d6c0';
      ctx.beginPath();
      ctx.moveTo(cx - 52, 512);
      ctx.lineTo(cx - 52, y + 60);
      ctx.arc(cx, y + 60, 52, Math.PI, 0);
      ctx.lineTo(cx + 52, 512);
      ctx.fill();
      ctx.fillStyle = r() < 0.7 ? '#2b4f8c' : '#c9a24a';
      ctx.beginPath();
      ctx.moveTo(cx - 42, 512);
      ctx.lineTo(cx - 42, y + 60);
      ctx.arc(cx, y + 60, 42, Math.PI, 0);
      ctx.lineTo(cx + 42, 512);
      ctx.fill();
      // studs
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      for (let i = 0; i < 6; i++) for (let j = 0; j < 8; j++) ctx.fillRect(cx - 34 + i * 14, y + 70 + j * 22, 3, 3);
      const wx = x0 + 180;
      frame(ctx, wx, y + 20, 50, 80, '#f0eee8', 6);
      glass(ctx, alpha, wx, y + 20, 50, 80, [60, 80, 100]);
      ctx.fillStyle = '#3b4a5a';
      for (let i = 0; i < 5; i++) ctx.fillRect(wx + i * 12, y + 20, 2, 80);
    } else {
      // garage / plain wall with vent
      ctx.fillStyle = '#9a9a96';
      ctx.fillRect(x0 + 40, y + 30, 176, 190);
      ctx.fillStyle = 'rgba(0,0,0,0.15)';
      for (let i = 0; i < 9; i++) ctx.fillRect(x0 + 40, y + 30 + i * 21, 176, 3);
    }
    // upper half: standard residential window (bay above shop)
    const w = 66;
    const h = 116;
    const x = x0 + 128 - w / 2;
    const yy = 60;
    frame(ctx, x, yy, w, h, '#f4f2ee', 8);
    glass(ctx, alpha, x, yy, w, h, [60, 80, 100]);
    ctx.fillStyle = '#e8e6e0';
    ctx.fillRect(x + w / 2 - 2, yy, 4, h);
    if (r() < 0.6) shutters(ctx, x, yy, w, h);
  }
}

function drawMedina(ctx, alpha, seed) {
  // Medina / Sidi Bou Said: thick whitewashed walls, few small openings,
  // studded blue doors, blue shutters and the odd wooden moucharabieh.
  plaster(ctx, seed, [242, 239, 231]);
  const r = rng(seed + 5);
  for (let bx = 0; bx < 2; bx++) {
    const x0 = bx * 256;
    const kind = r();
    if (kind < 0.55) {
      // arched studded door in the lower half
      const cx = x0 + 128;
      const top = 256 + 70;
      ctx.fillStyle = '#e6dcc4';
      ctx.beginPath(); ctx.moveTo(cx - 62, 512); ctx.lineTo(cx - 62, top + 62); ctx.arc(cx, top + 62, 62, Math.PI, 0); ctx.lineTo(cx + 62, 512); ctx.fill();
      ctx.fillStyle = r() < 0.75 ? '#2a4f8f' : '#c9a24a';
      ctx.beginPath(); ctx.moveTo(cx - 50, 512); ctx.lineTo(cx - 50, top + 62); ctx.arc(cx, top + 62, 50, Math.PI, 0); ctx.lineTo(cx + 50, 512); ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(cx - 2, top + 70, 4, 512 - top - 70);
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      for (let i = 0; i < 7; i++) for (let j = 0; j < 9; j++) ctx.fillRect(cx - 42 + i * 14, top + 80 + j * 20, 3, 3);
    } else if (kind < 0.8) {
      // small barred window low on the wall
      const wx = x0 + 100, wy = 256 + 110;
      frame(ctx, wx, wy, 56, 70, '#eee9de', 6);
      glass(ctx, alpha, wx, wy, 56, 70, [50, 65, 80]);
      ctx.fillStyle = '#2f5f9e';
      for (let i = 0; i < 5; i++) ctx.fillRect(wx + 4 + i * 12, wy, 3, 70);
      ctx.fillRect(wx, wy + 33, 56, 3);
    }
    // upper floor: shuttered window or a moucharabieh box
    if (r() < 0.35) {
      const mx = x0 + 70, my = 40, mw = 116, mh = 150;
      ctx.fillStyle = '#2f5f9e'; ctx.fillRect(mx, my, mw, mh);
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      for (let i = 0; i < 9; i++) ctx.fillRect(mx + 6 + i * 12, my + 6, 4, mh - 12);
      for (let j = 0; j < 11; j++) ctx.fillRect(mx + 6, my + 6 + j * 13, mw - 12, 3);
      ctx.fillStyle = '#eae4d5'; ctx.fillRect(mx - 8, my + mh, mw + 16, 8);
      alpha.fillStyle = '#666'; alpha.fillRect(mx + 10, my + 10, mw - 20, mh - 20);
    } else if (r() < 0.8) {
      const w = 54, h = 92, x = x0 + 128 - w / 2, y = 70;
      frame(ctx, x, y, w, h, '#f1eee6', 7);
      glass(ctx, alpha, x, y, w, h, [55, 72, 90]);
      ctx.fillStyle = '#e8e6e0'; ctx.fillRect(x + w / 2 - 2, y, 4, h);
      shutters(ctx, x, y, w, h, '#2f5f9e');
    }
  }
}

export function buildFacadeAtlas(renderer) {
  const data = new Uint8Array(SIZE * SIZE * 4 * LAYERS);
  const drawers = [
    (c, a, s) => plaster(c, s),
    drawResidential,
    drawOffice,
    drawArch,
    drawIndustrial,
    drawGround,
    drawMedina,
  ];
  for (let layer = 0; layer < LAYERS; layer++) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    const acan = document.createElement('canvas');
    acan.width = acan.height = SIZE;
    const actx = acan.getContext('2d');
    actx.fillStyle = '#000';
    actx.fillRect(0, 0, SIZE, SIZE);
    drawers[layer](ctx, actx, 1000 + layer * 17);
    const rgb = ctx.getImageData(0, 0, SIZE, SIZE).data;
    const al = actx.getImageData(0, 0, SIZE, SIZE).data;
    const off = layer * SIZE * SIZE * 4;
    for (let i = 0; i < SIZE * SIZE; i++) {
      // Canvas rows go top-down; texture rows go bottom-up (v = 0 at the base).
      const row = SIZE - 1 - Math.floor(i / SIZE);
      const col = i % SIZE;
      const src = (row * SIZE + col) * 4;
      const dst = off + i * 4;
      data[dst] = rgb[src];
      data[dst + 1] = rgb[src + 1];
      data[dst + 2] = rgb[src + 2];
      data[dst + 3] = al[src];
    }
  }
  const tex = new THREE.DataArrayTexture(data, SIZE, SIZE, LAYERS);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.needsUpdate = true;
  return tex;
}

// Wall material: standard PBR lighting, per-vertex colour, atlas layer chosen
// by the `style` attribute, night-time window glow.
export function createWallMaterial(atlas, shared) {
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.85,
    metalness: 0.0,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.facadeMap = { value: atlas };
    shader.uniforms.nightFactor = shared.nightFactor;
    shader.uniforms.bayM = { value: BAY_M };
    shader.uniforms.floorM = { value: FLOOR_M };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float style;
        varying float vStyle;
        varying vec2 vUvM;
        varying vec3 vWorldP;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vStyle = style;
        vUvM = uv;
        vWorldP = (modelMatrix * vec4(position, 1.0)).xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        precision highp sampler2DArray;
        uniform sampler2DArray facadeMap;
        uniform float nightFactor;
        uniform float bayM;
        uniform float floorM;
        varying float vStyle;
        varying vec2 vUvM;
        varying vec3 vWorldP;
        float hash12(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }`,
      )
      .replace(
        '#include <map_fragment>',
        `float layer = vStyle;
        if (vStyle > 0.5 && vStyle < 3.5 && vUvM.y < 6.2) layer = 5.0;
        vec2 fuv = vec2(vUvM.x / bayM, vUvM.y / floorM);
        vec4 facade = texture(facadeMap, vec3(fuv, layer));
        diffuseColor.rgb *= facade.rgb;
        float windowMask = facade.a;`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          vec2 cell = floor(vec2(vUvM.x / (bayM * 0.5), vUvM.y / (floorM * 0.5)));
          float lit = step(0.55, hash12(cell + floor(vWorldP.xz * 0.01) * 7.0));
          totalEmissiveRadiance += windowMask * lit * nightFactor * vec3(1.0, 0.82, 0.55) * 1.6;
        }`,
      );
  };
  mat.customProgramCacheKey = () => 'tunis-wall';
  return mat;
}
