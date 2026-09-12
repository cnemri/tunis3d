import * as THREE from 'three';

// Animated water: procedural wave normals, Fresnel blend between sky colour
// and the water body colour, sun glitter.  Cheap enough to cover the whole
// Gulf of Tunis and the Lac de Tunis at once.
export function createWaterMaterial(shared) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      time: { value: 0 },
      sunDir: shared.sunDir,
      sunColor: shared.sunColor,
      skyColor: { value: new THREE.Color(0x9fb8d6) },
      shallowColor: { value: new THREE.Color(0x3a8c94) },
      deepColor: { value: new THREE.Color(0x174f6e) },
      nightFactor: shared.nightFactor,
      fogColor: { value: new THREE.Color() },
      fogDensity: { value: 0 },
      cameraPos: { value: new THREE.Vector3() },
    },
    transparent: true,
    depthWrite: true,
    fog: false,
    vertexShader: `
      varying vec3 vWorld;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      uniform float time;
      uniform vec3 sunDir;
      uniform vec3 sunColor;
      uniform vec3 skyColor;
      uniform vec3 shallowColor;
      uniform vec3 deepColor;
      uniform float nightFactor;
      uniform vec3 fogColor;
      uniform float fogDensity;
      uniform vec3 cameraPos;
      varying vec3 vWorld;

      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p); vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
      }
      // Height field of a few directional waves plus noise ripples.
      float waveH(vec2 p) {
        float h = 0.0;
        h += 0.30 * sin(dot(p, vec2(0.09, 0.05)) + time * 0.9);
        h += 0.20 * sin(dot(p, vec2(-0.05, 0.12)) + time * 1.3);
        h += 0.12 * sin(dot(p, vec2(0.21, 0.17)) + time * 2.1);
        h += 0.25 * noise(p * 0.35 + vec2(time * 0.25, -time * 0.18));
        h += 0.12 * noise(p * 1.2 + vec2(-time * 0.4, time * 0.3));
        return h;
      }
      void main() {
        vec2 p = vWorld.xz;
        float e = 0.35;
        float h0 = waveH(p);
        float hx = waveH(p + vec2(e, 0.0));
        float hz = waveH(p + vec2(0.0, e));
        vec3 n = normalize(vec3(-(hx - h0) / e * 0.9, 1.0, -(hz - h0) / e * 0.9));
        vec3 v = normalize(cameraPos - vWorld);
        float dist = length(cameraPos - vWorld);
        // Flatten normals at distance to avoid aliasing sparkle.
        n = normalize(mix(n, vec3(0.0, 1.0, 0.0), clamp(dist / 6000.0, 0.0, 0.85)));
        float fres = pow(1.0 - max(dot(n, v), 0.0), 5.0);
        fres = mix(0.09, 1.0, fres);
        vec3 body = mix(shallowColor, deepColor, clamp(dist / 2500.0, 0.0, 1.0) * 0.4 + 0.3);
        vec3 refl = skyColor;
        vec3 hv = normalize(v + sunDir);
        float spec = pow(max(dot(n, hv), 0.0), 600.0) * 4.0 + pow(max(dot(n, hv), 0.0), 60.0) * 0.4;
        float sunUp = clamp(sunDir.y * 4.0, 0.0, 1.0);
        vec3 col = mix(body, refl, fres) + sunColor * spec * sunUp;
        col *= mix(1.0, 0.18, nightFactor);
        float fogF = 1.0 - exp(-fogDensity * fogDensity * dist * dist);
        col = mix(col, fogColor, clamp(fogF, 0.0, 1.0));
        gl_FragColor = vec4(col, 0.94);
      }
    `,
  });
  return mat;
}
