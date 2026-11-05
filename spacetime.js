import * as THREE from "three";
import { OrbitControls } from "./vendor/three/examples/jsm/controls/OrbitControls.js";

// Three time-as-space renderings of one clip, after spacetime_visualizations_technical_spec.md.
// Inputs are baked by lab.html's pipeline: assets/lab holds per-frame cut-outs (RGBA),
// Depth Anything V2 depth, the source frames and an empty-river plate.

const LAB = "assets/lab/";
const lab = await (await fetch(LAB + "lab.json")).json();
const { width: W, height: H, frames } = lab;
const N = frames.length;
const DUR = frames[N - 1].t - frames[0].t;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const image = (url) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = reject;
  img.src = LAB + url;
});
const scratch = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
function pixels(img, w = W, h = H) {
  scratch.canvas.width = w;
  scratch.canvas.height = h;
  scratch.drawImage(img, 0, 0, w, h);
  return scratch.getImageData(0, 0, w, h).data;
}

const [plate, plateDepth, cuts, depths, srcs] = await Promise.all([
  image("plate.jpg"),
  image("depth/plate.png"),
  Promise.all(frames.map((f) => image(f.file))),
  Promise.all(frames.map((f) => image(f.depth))),
  Promise.all(frames.map((f) => image(f.src))),
]);

// ── Timeline ─────────────────────────────────────────────────────────────

const playBtn = document.querySelector("#play");
const scrub = document.querySelector("#scrub");
const clock = document.querySelector("#clock");
let playing = true;
let u = 0; // normalised clip time, 0..1
playBtn.onclick = () => { playing = !playing; playBtn.textContent = playing ? "❚❚" : "▶"; };
scrub.oninput = () => { u = +scrub.value; playing = false; playBtn.textContent = "▶"; };
const frameNow = () => u * (N - 1); // fractional frame index

// ── Panel scaffolding ────────────────────────────────────────────────────

const panels = [];
function panel(view, { fov = 45, position, target }) {
  const root = document.querySelector(`[data-view="${view}"]`);
  const canvas = root.querySelector("canvas");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050403);
  const camera = new THREE.PerspectiveCamera(fov, 16 / 9, 0.01, 300);
  camera.position.copy(position);
  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(target);
  controls.enableDamping = true;
  controls.update();
  const p = { scene, camera, controls, renderer, canvas, fov, hud: root.querySelector(".hud"), update: () => {} };
  new ResizeObserver(() => {
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    camera.aspect = canvas.clientWidth / canvas.clientHeight;
    camera.updateProjectionMatrix();
  }).observe(canvas);
  panels.push(p);
  return p;
}
const V = (x, y, z) => new THREE.Vector3(x, y, z);

// ── 1 · 4D volumetric point-cloud trail ──────────────────────────────────
// The camera never moves, so every frame lifts into one world. Depth Anything's
// depth is relative per frame: each frame is fitted (scale + offset) to the plate's
// depth over its background pixels, so the bear lands at a depth consistent with
// the river around it. Time is the per-point attribute a_frameId.

const FOV_X = THREE.MathUtils.degToRad(70);
const TX = Math.tan(FOV_X / 2);
const TY = (TX * H) / W;
const OVERLAY = 0.9; // the trail cam's timestamp bar fills the bottom tenth
const KEEP = 0.15; // per-frame subsample, spec: 10-20 %
const zOf = (d) => 2 / (0.08 + d);
const spacing = (z, step) => (step * 2 * TX * z) / W;

function buildCloud() {
  const plateRGB = pixels(plate);
  const plateD = pixels(plateDepth);
  const env = { p: [], c: [], s: [] };
  for (let v = 0; v < H * OVERLAY; v += 2) {
    for (let x = 0; x < W; x += 2) {
      const k = (v * W + x) * 4;
      const z = zOf(plateD[k] / 255);
      env.p.push(((x / W) * 2 - 1) * TX * z, -((v / H) * 2 - 1) * TY * z, -z);
      env.c.push(plateRGB[k] / 255, plateRGB[k + 1] / 255, plateRGB[k + 2] / 255);
      env.s.push(spacing(z, 2) * 1.5);
    }
  }

  const subject = { p: [], c: [], id: [], s: [] };
  const path = [];
  frames.forEach((_, i) => {
    const rgba = pixels(cuts[i]);
    const dep = pixels(depths[i]);
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let k = 0; k < rgba.length; k += 28) {
      if (rgba[k + 3] > 10 || k / 4 / W > H * OVERLAY) continue;
      const a = dep[k] / 255, b = plateD[k] / 255;
      n++; sx += a; sy += b; sxx += a * a; sxy += a * b;
    }
    const det = n * sxx - sx * sx;
    const gain = det > 1e-6 ? (n * sxy - sx * sy) / det : 1;
    const bias = det > 1e-6 ? (sy - gain * sx) / n : 0;
    const centre = V(0, 0, 0);
    let m = 0;
    for (let v = 0; v < H; v++) {
      for (let x = 0; x < W; x++) {
        const k = (v * W + x) * 4;
        if (rgba[k + 3] < 128) continue;
        const z = zOf(clamp(gain * dep[k] / 255 + bias, 0, 1));
        const px = ((x / W) * 2 - 1) * TX * z, py = -((v / H) * 2 - 1) * TY * z;
        centre.x += px; centre.y += py; centre.z -= z; m++;
        if (Math.random() > KEEP) continue;
        subject.p.push(px, py, -z);
        subject.c.push(rgba[k] / 255, rgba[k + 1] / 255, rgba[k + 2] / 255);
        subject.id.push(i);
        subject.s.push(spacing(z, 1) * 1.3);
      }
    }
    path.push(centre.divideScalar(m));
  });

  const geometry = ({ p, c, id = [], s }) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(p, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(c, 3));
    g.setAttribute("a_frameId", new THREE.Float32BufferAttribute(id, 1));
    g.setAttribute("aSize", new THREE.Float32BufferAttribute(s, 1));
    return g;
  };
  return { env: geometry(env), subject: geometry(subject), path };
}

const cloudVertex = /* glsl */ `
  attribute float a_frameId;
  attribute float aSize;
  attribute vec3 color;
  uniform float u_currentTime;
  uniform float u_timeWindow;
  uniform float u_focal;
  varying float v_isPresent;
  varying vec3 v_color;
  void main() {
    float dist = abs(a_frameId - u_currentTime);
    v_isPresent = smoothstep(u_timeWindow, 0.0, dist);
    v_color = color;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    // spec's mix(2, 5) px, attenuated by distance so the cloud stays a volume
    gl_PointSize = clamp(aSize * u_focal / -mv.z * mix(1.0, 2.5, v_isPresent), 1.0, 40.0);
    gl_Position = projectionMatrix * mv;
  }
`;
const cloudFragment = /* glsl */ `
  varying float v_isPresent;
  varying vec3 v_color;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    if (dot(d, d) > 0.25) discard;
    vec3 trailColor = vec3(0.7, 0.25, 0.35);
    vec3 activeColor = vec3(0.2, 1.0, 1.0);
    // the footage's luminance rides on both tints so the animal keeps its form
    float luma = 0.45 + 1.1 * dot(v_color, vec3(0.3, 0.59, 0.11));
    vec3 finalColor = mix(trailColor, activeColor, v_isPresent) * luma;
    float alpha = mix(0.08, 1.0, v_isPresent);
    gl_FragColor = vec4(finalColor, alpha);
  }
`;

{
  const cloud = buildCloud();
  const box = new THREE.Box3().setFromPoints(cloud.path);
  const centre = box.getCenter(V(0, 0, 0));
  const reach = Math.max(box.getSize(V(0, 0, 0)).length(), 2);
  const p = panel("cloud", {
    fov: 40,
    position: centre.clone().add(V(reach * 1.3, reach * 0.6, reach * 0.9)),
    target: centre,
  });

  const env = new THREE.Points(cloud.env, new THREE.ShaderMaterial({
    uniforms: { u_focal: { value: 500 } },
    vertexShader: cloudVertex.replace("mix(1.0, 2.5, v_isPresent)", "1.0"),
    fragmentShader: /* glsl */ `
      varying vec3 v_color;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        if (dot(d, d) > 0.25) discard;
        gl_FragColor = vec4(v_color * 0.32, 1.0);
      }
    `,
  }));
  env.frustumCulled = false;
  p.scene.add(env);

  const trail = new THREE.Points(cloud.subject, new THREE.ShaderMaterial({
    uniforms: { u_currentTime: { value: 0 }, u_timeWindow: { value: 3 }, u_focal: { value: 500 } },
    vertexShader: cloudVertex,
    fragmentShader: cloudFragment,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }));
  trail.frustumCulled = false;
  p.scene.add(trail);

  // recording camera: wireframe pyramid + live frame quad, bound to the (fixed) camera transform
  const D = 1.0;
  const apex = V(0, 0, 0);
  const corners = [[-1, 1], [1, 1], [1, -1], [-1, -1]].map(([sx, sy]) => V(sx * TX * D, sy * TY * D, -D));
  const lines = [];
  corners.forEach((c, i) => lines.push(apex, c, c, corners[(i + 1) % 4]));
  p.scene.add(new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints(lines),
    new THREE.LineBasicMaterial({ color: 0xffd9a8 }),
  ));
  const textures = srcs.map((img) => {
    const t = new THREE.Texture(img);
    t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  });
  const quad = new THREE.Mesh(
    new THREE.PlaneGeometry(2 * TX * D, 2 * TY * D),
    new THREE.MeshBasicMaterial({ map: textures[0] }),
  );
  quad.position.z = -D;
  p.scene.add(quad);

  p.update = () => {
    const f = frameNow();
    const focal = p.canvas.height / (2 * Math.tan(THREE.MathUtils.degToRad(p.fov / 2)));
    env.material.uniforms.u_focal.value = trail.material.uniforms.u_focal.value = focal;
    trail.material.uniforms.u_currentTime.value = f;
    quad.material.map = textures[Math.round(f)];
    p.hud.textContent = `t_now ${f.toFixed(1)} / ${N - 1}   Δt ${trail.material.uniforms.u_timeWindow.value}\n${cloud.subject.attributes.position.count.toLocaleString()} trail points`;
  };
}

// ── 2 · 3.5D segmented chrono-extrusion ──────────────────────────────────
// A texture-array ring buffer holds the last R frames' cut-out and depth. Playing
// writes one layer per frame (addLayerUpdate); nothing is shifted. Instance i is
// the slice of age i, fetching layer (head − i) mod R.

{
  const R = 64, RW = 320, RH = 180;
  const rgbaSize = RW * RH * 4, depthSize = RW * RH;
  const frameRGBA = cuts.map((img) => Uint8Array.from(pixels(img, RW, RH)));
  const frameDepth = depths.map((img) => {
    const px = pixels(img, RW, RH);
    return Uint8Array.from({ length: depthSize }, (_, k) => px[k * 4]);
  });
  const ringRGBA = new Uint8Array(rgbaSize * R);
  const ringDepth = new Uint8Array(depthSize * R);
  const makeArray = (data, format) => {
    const t = new THREE.DataArrayTexture(data, RW, RH, R);
    t.format = format;
    t.type = THREE.UnsignedByteType;
    t.minFilter = t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    return t;
  };
  const texRGBA = makeArray(ringRGBA, THREE.RGBAFormat);
  const texDepth = makeArray(ringDepth, THREE.RedFormat);

  let written = -1;
  function feed(f) {
    if (f === written) return;
    const from = f > written && f - written < R ? written + 1 : Math.max(0, f - R + 1);
    for (let i = from; i <= f; i++) {
      const slot = i % R;
      ringRGBA.set(frameRGBA[i], slot * rgbaSize);
      ringDepth.set(frameDepth[i], slot * depthSize);
      texRGBA.addLayerUpdate(slot);
      texDepth.addLayerUpdate(slot);
    }
    texRGBA.needsUpdate = texDepth.needsUpdate = true;
    written = f;
  }

  const WORLD_W = 4, WORLD_H = (WORLD_W * H) / W;
  const p = panel("extrude", { fov: 40, position: V(8.5, 2.6, 1.0), target: V(0.5, 0, -5.4) });

  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: {
      u_depthArray: { value: texDepth },
      u_rgbaArray: { value: texRGBA },
      u_sliceSpacing: { value: 0.18 },
      u_depthScale: { value: 0.3 },
      u_headIndex: { value: 0 },
      u_totalSlices: { value: R },
      u_filled: { value: 1 },
      u_decayRate: { value: 0.055 },
      u_dir: { value: V(0.1, 0.01, -1).normalize() },
      u_flip: { value: 0 },
    },
    vertexShader: /* glsl */ `
      precision highp sampler2DArray;
      uniform sampler2DArray u_depthArray;
      uniform sampler2DArray u_rgbaArray;
      uniform float u_sliceSpacing, u_depthScale, u_flip;
      uniform int u_headIndex, u_totalSlices, u_filled;
      uniform vec3 u_dir;
      out vec2 vUv;
      flat out int vSliceAge;
      flat out int vTexLayer;
      void main() {
        vUv = vec2(uv.x, 1.0 - uv.y); // array layers are stored top row first
        // 0 = newest. Instances draw in id order, so by default the oldest draws first
        // (back to front); u_flip restores id = age when viewed from behind the stack.
        vSliceAge = u_flip > 0.5 ? gl_InstanceID : u_totalSlices - 1 - gl_InstanceID;
        vTexLayer = (u_headIndex - vSliceAge + u_totalSlices) % u_totalSlices;
        if (vSliceAge >= u_filled) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
        vec3 at = vec3(vUv, float(vTexLayer));
        float relief = texture(u_depthArray, at).r * step(0.5, texture(u_rgbaArray, at).a);
        vec3 displaced = position + u_dir * float(vSliceAge) * u_sliceSpacing + vec3(0.0, 0.0, relief * u_depthScale);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp sampler2DArray;
      uniform sampler2DArray u_rgbaArray;
      uniform float u_decayRate;
      layout(location = 0) out highp vec4 fragColor;
      in vec2 vUv;
      flat in int vSliceAge;
      flat in int vTexLayer;
      void main() {
        vec4 texel = texture(u_rgbaArray, vec3(vUv, float(vTexLayer)));
        float ageFactor = exp(-u_decayRate * float(vSliceAge));
        float a = texel.a * ageFactor;
        if (a < 0.01) discard;
        fragColor = vec4(texel.rgb, a);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const slices = new THREE.InstancedMesh(new THREE.PlaneGeometry(WORLD_W, WORLD_H, 255, 143), material, R);
  slices.frustumCulled = false;
  const group = new THREE.Group();
  group.add(slices);

  // the empty river far behind the stack, for context
  const plateTex = new THREE.Texture(plate);
  plateTex.colorSpace = THREE.SRGBColorSpace;
  plateTex.needsUpdate = true;
  const backdrop = new THREE.Mesh(
    new THREE.PlaneGeometry(WORLD_W, WORLD_H),
    new THREE.MeshBasicMaterial({ map: plateTex, color: 0x555555 }),
  );
  backdrop.position.copy(material.uniforms.u_dir.value).multiplyScalar((R + 1) * 0.18);
  group.add(backdrop);
  p.scene.add(group);
  const stackDir = material.uniforms.u_dir.value;

  p.update = () => {
    const f = Math.round(frameNow());
    feed(f);
    const un = material.uniforms;
    un.u_headIndex.value = f % R;
    un.u_filled.value = Math.min(f + 1, R);
    un.u_flip.value = p.camera.position.dot(stackDir) > 0 ? 1 : 0;
    p.hud.textContent = `head layer ${f % R}   filled ${un.u_filled.value} / ${R}\nλ ${un.u_decayRate.value}   Δz ${un.u_sliceSpacing.value}`;
  };
}

// ── 3 · Spatiotemporal video volume ──────────────────────────────────────
// The clip as a sampler3D (U = x, V = y, W = time), ray-marched through a unit
// box scaled to the video's aspect. A thin slab at w_now is lifted to near-opaque.

{
  const VW = 256, VH = 144;
  const voxels = new Uint8Array(VW * VH * N * 4);
  srcs.forEach((img, i) => voxels.set(pixels(img, VW, VH), i * VW * VH * 4));
  const volume = new THREE.Data3DTexture(voxels, VW, VH, N);
  volume.format = THREE.RGBAFormat;
  volume.type = THREE.UnsignedByteType;
  volume.minFilter = volume.magFilter = THREE.LinearFilter;
  volume.unpackAlignment = 1;
  volume.needsUpdate = true;

  const SCALE = V(4, (4 * H) / W, 2.6); // (16 : 9 : depth)
  const p = panel("volume", { fov: 40, position: V(2.6, 1.3, 6.4), target: V(0, 0, 0) });

  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: {
      u_videoVolume: { value: volume },
      u_activeSliceZ: { value: 0 },
      u_sliceThickness: { value: 0.5 / N },
    },
    vertexShader: /* glsl */ `
      out vec3 vOrigin;
      out vec3 vDir;
      void main() {
        vOrigin = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;
        vDir = position - vOrigin;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp sampler3D;
      uniform sampler3D u_videoVolume;
      uniform float u_activeSliceZ; // normalised [0, 1]
      uniform float u_sliceThickness;
      layout(location = 0) out highp vec4 fragColor;
      in vec3 vOrigin;
      in vec3 vDir;

      vec2 hitBox(vec3 o, vec3 d) {
        vec3 inv = 1.0 / d;
        vec3 a = (-0.5 - o) * inv, b = (0.5 - o) * inv;
        vec3 lo = min(a, b), hi = max(a, b);
        return vec2(max(max(lo.x, lo.y), lo.z), min(min(hi.x, hi.y), hi.z));
      }

      vec4 marchVolume(vec3 rayOrigin, vec3 rayDir, float tNear, float tFar) {
        const int STEPS = 256;
        float stepSize = (tFar - tNear) / float(STEPS);
        vec3 pos = rayOrigin + rayDir * tNear;
        vec4 accum = vec4(0.0);
        for (int i = 0; i < STEPS; i++) {
          vec3 uvw = vec3(pos.x + 0.5, 0.5 - pos.y, pos.z + 0.5); // box space -> UVW, image row 0 on top
          vec3 rgb = texture(u_videoVolume, uvw).rgb;
          // highlight the active 2D time-slice plane
          float isSlice = step(abs(uvw.z - u_activeSliceZ), u_sliceThickness);
          float stepAlpha = mix(0.012, 0.95, isSlice);
          // front-to-back compositing
          accum.rgb += (1.0 - accum.a) * rgb * stepAlpha;
          accum.a += (1.0 - accum.a) * stepAlpha;
          if (accum.a >= 0.99) break;
          pos += rayDir * stepSize;
        }
        return accum;
      }

      void main() {
        vec3 rd = normalize(vDir);
        vec2 t = hitBox(vOrigin, rd);
        if (t.x > t.y) discard;
        vec4 c = marchVolume(vOrigin, rd, max(t.x, 0.0), t.y);
        fragColor = vec4(c.rgb, 1.0);
      }
    `,
    side: THREE.BackSide,
  });
  const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
    new THREE.LineBasicMaterial({ color: 0xffd9a8, transparent: true, opacity: 0.55 }),
  );
  const border = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints([V(-0.5, -0.5, 0), V(0.5, -0.5, 0), V(0.5, 0.5, 0), V(-0.5, 0.5, 0)]),
    new THREE.LineBasicMaterial({ color: 0x66ffff }),
  );
  const group = new THREE.Group();
  group.scale.copy(SCALE);
  group.add(box, edges, border);
  p.scene.add(group);

  p.update = () => {
    const w = (frameNow() + 0.5) / N;
    material.uniforms.u_activeSliceZ.value = w;
    border.position.z = w - 0.5;
    p.hud.textContent = `w_now ${w.toFixed(3)}   256 steps · α 0.012 / 0.95`;
  };
}

// ── Main loop ────────────────────────────────────────────────────────────

document.querySelector("#verdict").textContent = `${N} frames · ${DUR.toFixed(1)}s clip`;
let last = performance.now();
renderLoop();
function renderLoop(now = performance.now()) {
  if (playing) u = (u + Math.max(0, now - last) / 1000 / DUR) % 1;
  last = now;
  scrub.value = u;
  clock.textContent = `${(u * DUR).toFixed(2)}s`;
  for (const p of panels) {
    p.controls.update();
    p.update();
    p.renderer.render(p.scene, p.camera);
  }
  requestAnimationFrame(renderLoop);
}

window.__spacetime = { get u() { return u; }, set u(v) { u = v; playing = false; }, panels };
