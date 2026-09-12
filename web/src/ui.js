import * as THREE from 'three';
import { xzToLonLat, lonLatToXZ, lonLatToTile } from './geo.js';

// Head-up display, control panel and a satellite minimap.
export class UI {
  constructor(app) {
    this.app = app;
    this.$ = (id) => document.getElementById(id);
    this.lastHud = 0;
    this.minimapZoom = 12;
    this.minimapReady = false;
    this.bind();
  }

  bind() {
    const { app } = this;
    this.$('mode-fly').onclick = () => app.nav.setMode('fly');
    this.$('mode-walk').onclick = () => app.nav.setMode('walk');
    app.nav.onModeChange = (m) => {
      this.$('mode-fly').classList.toggle('active', m === 'fly');
      this.$('mode-walk').classList.toggle('active', m === 'walk');
    };
    this.$('btn-overview').onclick = () => app.overview();
    this.$('hour').oninput = (e) => app.setHour(parseFloat(e.target.value));
    this.$('opt-roofs').onchange = (e) => app.world.setRoofImagery(e.target.checked);
    this.$('opt-roads').onchange = (e) => app.world.setLayerVisible('roads', e.target.checked);
    this.$('opt-trees').onchange = (e) => app.world.setLayerVisible('trees', e.target.checked);
    this.$('opt-shadows').onchange = (e) => app.setShadows(e.target.checked);
    this.$('goto').onchange = (e) => {
      const id = e.target.value;
      if (id) app.gotoLandmark(id);
      e.target.value = '';
    };
  }

  populateLandmarks(list) {
    const sel = this.$('goto');
    for (const lm of list) {
      const o = document.createElement('option');
      o.value = lm.id;
      o.textContent = lm.name + (lm.matched === 'fallback' ? ' (approx.)' : '');
      sel.appendChild(o);
    }
  }

  setLoading(text, frac) {
    this.$('loading-status').textContent = text;
    if (frac !== undefined) this.$('loading-bar').style.width = `${Math.round(frac * 100)}%`;
  }

  hideLoading() {
    const el = this.$('loading');
    el.style.opacity = '0';
    setTimeout(() => (el.style.display = 'none'), 700);
  }

  nearestPlace(x, z) {
    const places = this.app.landmarks.places || [];
    let best = null, bd = Infinity;
    for (const p of places) {
      const d = Math.hypot(p.center[0] - x, p.center[1] - z);
      const w = p.place === 'suburb' ? 1.0 : p.place === 'neighbourhood' || p.place === 'quarter' ? 0.6 : 1.6;
      if (d * w < bd) { bd = d * w; best = p; }
    }
    return best && bd < 2500 ? best : null;
  }

  update(time, fps) {
    if (time - this.lastHud < 0.25) return;
    this.lastHud = time;
    const cam = this.app.camera;
    const [lon, lat] = xzToLonLat(cam.position.x, cam.position.z);
    const ground = this.app.world.heightAt(cam.position.x, cam.position.z);
    const place = this.nearestPlace(cam.position.x, cam.position.z);
    this.$('hud-place').textContent = place ? `${place.name}${place.name_ar ? ' · ' + place.name_ar : ''}` : 'Tunis';
    this.$('hud-coords').textContent = `${lat.toFixed(5)}°N  ${lon.toFixed(5)}°E`;
    this.$('hud-alt').textContent = `alt ${cam.position.y.toFixed(0)} m ASL · ground ${ground.toFixed(0)} m · ${this.app.nav.mode}`;
    const w = this.app.world;
    this.$('hud-stats').textContent = `${fps.toFixed(0)} fps · ${w.stats.chunksLoaded} chunks · ${(w.stats.buildingsVerts / 1e6).toFixed(1)}M wall verts`;
    this.drawMinimap(cam);
  }

  async initMinimap(bbox) {
    // Mosaic of zoom-12 satellite tiles covering the data bbox.
    const z = this.minimapZoom;
    const [x0, y0] = lonLatToTile(bbox[0], bbox[3], z).map(Math.floor);
    const [x1, y1] = lonLatToTile(bbox[2], bbox[1], z).map(Math.floor);
    const nx = x1 - x0 + 1, ny = y1 - y0 + 1;
    const c = document.createElement('canvas');
    c.width = nx * 256; c.height = ny * 256;
    const ctx = c.getContext('2d');
    const jobs = [];
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
      jobs.push(new Promise((res) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => { ctx.drawImage(img, i * 256, j * 256); res(); };
        img.onerror = res;
        img.src = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y0 + j}/${x0 + i}`;
      }));
    }
    await Promise.all(jobs);
    this.minimap = { canvas: c, x0, y0, nx, ny, z };
    this.minimapReady = true;
  }

  drawMinimap(cam) {
    if (!this.minimapReady) return;
    const mc = this.$('minimap-canvas');
    const ctx = mc.getContext('2d');
    const { canvas, x0, y0, z } = this.minimap;
    const [lon, lat] = xzToLonLat(cam.position.x, cam.position.z);
    const [tx, ty] = lonLatToTile(lon, lat, z);
    const px = (tx - x0) * 256, py = (ty - y0) * 256;
    // window scale: zoom out with altitude
    const alt = Math.max(50, cam.position.y);
    const scale = THREE.MathUtils.clamp(2.2 - Math.log10(alt) * 0.5, 0.45, 1.8);
    const size = mc.width / scale;
    ctx.fillStyle = '#0b0e14';
    ctx.fillRect(0, 0, mc.width, mc.height);
    ctx.drawImage(canvas, px - size / 2, py - size / 2, size, size, 0, 0, mc.width, mc.height);
    // camera marker + heading cone
    const cx = mc.width / 2, cy = mc.height / 2;
    const yaw = this.app.nav.yaw;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-yaw);
    ctx.fillStyle = 'rgba(79,179,217,0.35)';
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-28, -70); ctx.lineTo(28, -70); ctx.closePath(); ctx.fill();
    ctx.restore();
    ctx.fillStyle = '#4fb3d9';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(cx, cy, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    // landmarks
    ctx.fillStyle = '#ffd166';
    for (const lm of this.app.landmarks.list || []) {
      const [ltx, lty] = lonLatToTile(lm.lonlat[0], lm.lonlat[1], z);
      const lx = ((ltx - x0) * 256 - (px - size / 2)) * scale;
      const ly = ((lty - y0) * 256 - (py - size / 2)) * scale;
      if (lx < 0 || ly < 0 || lx > mc.width || ly > mc.height) continue;
      ctx.beginPath(); ctx.arc(lx, ly, 3.5, 0, Math.PI * 2); ctx.fill();
    }
  }
}
