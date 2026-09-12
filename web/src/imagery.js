import * as THREE from 'three';

// Satellite imagery draped over the terrain.  A texture covers one slippy tile
// (z, x, y) and is a mosaic of 4^k sub-tiles at zoom z+k.  Tiles are read from
// the local cache written by pipeline/fetch_imagery.py when present and
// streamed from Esri World Imagery otherwise.
const LOCAL_TEMPLATE = '/data/imagery/{z}/{x}/{y}.jpg';
const REMOTE_TEMPLATE =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

const TILE_PX = 256;

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`image failed: ${url}`));
    img.src = url;
  });
}

async function loadTile(z, x, y) {
  const local = LOCAL_TEMPLATE.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  try {
    return await loadImage(local);
  } catch (_) {
    const remote = REMOTE_TEMPLATE.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    return loadImage(remote);
  }
}

export class ImageryLoader {
  constructor(renderer) {
    this.maxAniso = renderer.capabilities.getMaxAnisotropy();
    this.cache = new Map(); // key -> Promise<THREE.Texture>
    this.inflight = 0;
  }

  // Texture for tile (z, x, y) at detail level k (0..3).  `transform` is an
  // optional {repeat, offset} applied to the texture so that geometry with
  // parent-tile UVs can sample a child tile's texture.
  get(z, x, y, k, transform) {
    const key = `${z}_${x}_${y}_${k}`;
    let p = this.cache.get(key);
    if (!p) {
      p = this.build(z, x, y, k, transform);
      this.cache.set(key, p);
    }
    return p;
  }

  async build(z, x, y, k, transform) {
    const n = 1 << k;
    const size = TILE_PX * n;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#8a8f7a';
    ctx.fillRect(0, 0, size, size);
    const zz = z + k;
    const jobs = [];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        jobs.push(
          loadTile(zz, x * n + i, y * n + j)
            .then((img) => ctx.drawImage(img, i * TILE_PX, j * TILE_PX, TILE_PX, TILE_PX))
            .catch(() => {}),
        );
      }
    }
    this.inflight += jobs.length;
    await Promise.all(jobs);
    this.inflight -= jobs.length;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.maxAniso;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    if (transform) {
      tex.repeat.copy(transform.repeat);
      tex.offset.copy(transform.offset);
    }
    tex.needsUpdate = true;
    return tex;
  }

  release(z, x, y, k) {
    const key = `${z}_${x}_${y}_${k}`;
    const p = this.cache.get(key);
    if (p) {
      this.cache.delete(key);
      p.then((t) => t.dispose());
    }
  }
}
