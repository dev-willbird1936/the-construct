import * as THREE from "three";
import { OrbitControls } from "./vendor/three/examples/jsm/controls/OrbitControls.js";

// ── Data ─────────────────────────────────────────────────────────────────
// assets/lab is baked by backend/tools/make-lab.mjs (cut-outs, source frames,
// plate) and a Depth Anything V2 pass (per-frame relative depth).

const LAB = "assets/lab/";
const lab = await (await fetch(LAB + "lab.json")).json();
const { width: W, height: H, fps, srcCount, frames } = lab;
const N = frames.length;
const DUR = srcCount / fps;
const T0 = frames[0].t;
const T1 = frames[N - 1].t;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const norm = (T) => clamp((T - T0) / (T1 - T0), 0, 1);
frames.forEach((f) => { f.u = norm(f.t); });

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

const srcNames = Array.from({ length: srcCount }, (_, i) => `src/f${String(i + 1).padStart(4, "0")}.jpg`);
const [plate, plateDepth, cuts, depths, srcs] = await Promise.all([
  image("plate.jpg"),
  image("depth/plate.png"),
  Promise.all(frames.map((f) => image(f.file))),
  Promise.all(frames.map((f) => image(f.depth))),
  Promise.all(srcNames.map(image)),
]);

// ── Lifting frames into one 3D space ─────────────────────────────────────
// The camera never moves, so every frame shares one world. Depth Anything's
// output is relative per frame, so each frame is fitted (scale + offset) to the
// plate's depth over its background pixels; the animal then lands at a depth
// consistent with the river around it.

const FOV_X = THREE.MathUtils.degToRad(70); // trail cams are wide
const TX = Math.tan(FOV_X / 2);
const TY = TX * H / W;
const OVERLAY = 0.9; // the camera's timestamp bar fills the bottom tenth
const zOf = (d) => 2 / (0.08 + d);
const spacing = (z, step) => (step * 2 * TX * z) / W;

const plateRGB = pixels(plate);
const plateD = pixels(plateDepth);

function buildClouds() {
  const plateGeo = { p: [], c: [], t: [], s: [] };
  for (let v = 0; v < H * OVERLAY; v += 2) {
    for (let u = 0; u < W; u += 2) {
      const k = (v * W + u) * 4;
      const z = zOf(plateD[k] / 255);
      plateGeo.p.push(((u / W) * 2 - 1) * TX * z, -((v / H) * 2 - 1) * TY * z, -z);
      plateGeo.c.push(plateRGB[k] / 255, plateRGB[k + 1] / 255, plateRGB[k + 2] / 255);
      plateGeo.t.push(-1);
      plateGeo.s.push(spacing(z, 2) * 1.5);
    }
  }

  const subject = { p: [], c: [], t: [], s: [] };
  const path = [];
  frames.forEach((f, i) => {
    const rgba = pixels(cuts[i]);
    const dep = pixels(depths[i]);
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let k = 0; k < rgba.length; k += 4 * 7) {
      if (rgba[k + 3] > 10 || (k / 4 / W) > H * OVERLAY) continue;
      const x = dep[k] / 255, y = plateD[k] / 255;
      n++; sx += x; sy += y; sxx += x * x; sxy += x * y;
    }
    const det = n * sxx - sx * sx;
    const a = det > 1e-6 ? (n * sxy - sx * sy) / det : 1;
    const b = det > 1e-6 ? (sy - a * sx) / n : 0;
    let cx = 0, cy = 0, cz = 0, m = 0;
    for (let v = 0; v < H; v += 2) {
      for (let u = 0; u < W; u += 2) {
        const k = (v * W + u) * 4;
        if (rgba[k + 3] < 128) continue;
        const z = zOf(clamp(a * dep[k] / 255 + b, 0, 1));
        const x = ((u / W) * 2 - 1) * TX * z;
        const y = -((v / H) * 2 - 1) * TY * z;
        subject.p.push(x, y, -z);
        subject.c.push(rgba[k] / 255, rgba[k + 1] / 255, rgba[k + 2] / 255);
        subject.t.push(f.u);
        subject.s.push(spacing(z, 2) * 1.6);
        cx += x; cy += y; cz -= z; m++;
      }
    }
    path.push(new THREE.Vector3(cx / m, cy / m, cz / m));
  });

  const geometry = ({ p, c, t, s }) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(p, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(c, 3));
    g.setAttribute("aT", new THREE.Float32BufferAttribute(t, 1));
    g.setAttribute("aSize", new THREE.Float32BufferAttribute(s, 1));
    return g;
  };
  return { plate: geometry(plateGeo), subject: geometry(subject), path };
}

const clouds = buildClouds();
const path = clouds.path;
// a lightly smoothed path, for anything that has to follow it
const smooth = path.map((_, i) => {
  const s = new THREE.Vector3();
  let n = 0;
  for (let j = Math.max(0, i - 4); j <= Math.min(N - 1, i + 4); j++, n++) s.add(path[j]);
  return s.divideScalar(n);
});
const pathAt = (u) => {
  const k = clamp(u, 0, 1) * (N - 1);
  const i = Math.floor(k);
  return smooth[i].clone().lerp(smooth[Math.min(N - 1, i + 1)], k - i);
};
const pathBox = new THREE.Box3().setFromPoints(path);
const pathCentre = pathBox.getCenter(new THREE.Vector3());
const pathSize = pathBox.getSize(new THREE.Vector3());
const reach = Math.max(pathSize.x, pathSize.z, 1.5);

// ── Direction of travel ──────────────────────────────────────────────────
// Toward/away is read two independent ways: the lifted depth of the animal,
// and how much of the frame it fills. Both have to agree for a verdict.

const mean = (list) => list.reduce((s, v) => s.add(v), new THREE.Vector3()).divideScalar(list.length);
const start = mean(path.slice(0, 8));
const end = mean(path.slice(-8));
const avg = (list) => list.reduce((s, v) => s + v, 0) / list.length;
const growth = avg(frames.slice(-10).map((f) => f.area)) / avg(frames.slice(0, 10).map((f) => f.area));
const depthRatio = -end.z / -start.z;
const travel = end.clone().sub(start);
const toward = depthRatio < 0.9 && growth > 1.15;
const away = depthRatio > 1.1 && growth < 0.87;
const radial = toward ? "TOWARD CAMERA" : away ? "AWAY FROM CAMERA" : "ACROSS";
const lateral = Math.abs(travel.x) < 0.15 * -start.z ? "" : travel.x < 0 ? " · LEFTWARD" : " · RIGHTWARD";
const verdict = radial + lateral;
document.querySelector("#verdict").textContent =
  `motion: ${verdict} · depth ×${depthRatio.toFixed(2)} · size ×${growth.toFixed(2)}`;

// ── Shared point material ────────────────────────────────────────────────

const pointVertex = /* glsl */ `
  attribute float aT;
  attribute float aSize;
  attribute vec3 color;
  uniform float uNow, uPixel, uMode, uTrail, uReveal, uDim, uWindow;
  varying vec3 vC;
  vec3 turbo(float t) {
    const vec4 kr4 = vec4(0.13572138, 4.61539260, -42.66032258, 132.13108234);
    const vec4 kg4 = vec4(0.09140261, 2.19418839, 4.84296658, -14.18503333);
    const vec4 kb4 = vec4(0.10667330, 12.64194608, -60.58204836, 110.36276771);
    const vec2 kr2 = vec2(-152.94239396, 59.28637943);
    const vec2 kg2 = vec2(4.27729857, 2.82956604);
    const vec2 kb2 = vec2(-89.90310912, 27.34824973);
    t = clamp(t, 0.0, 1.0);
    vec4 v4 = vec4(1.0, t, t * t, t * t * t);
    vec2 v2 = v4.zw * v4.z;
    return vec3(dot(v4, kr4) + dot(v2, kr2), dot(v4, kg4) + dot(v2, kg2), dot(v4, kb4) + dot(v2, kb2));
  }
  void main() {
    if (uReveal > 0.5 && (aT > uNow + 1e-4 || (aT >= 0.0 && uNow - aT > uWindow))) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      vC = vec3(0.0);
      return;
    }
    float now = aT < 0.0 ? 0.0 : 1.0 - smoothstep(0.0, 0.02, abs(uNow - aT));
    vec3 c = color;
    if (uMode > 1.5) c = vec3(dot(color, vec3(0.3, 0.59, 0.11))) * 0.55;
    else if (uMode > 0.5) c = mix(turbo(0.08 + aT * 0.86), vec3(1.0), now * 0.9);
    else if (aT >= 0.0) c *= mix(uTrail, 1.3, now);
    vC = c * uDim;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    // capped, so points right at the lens stay splats instead of screen-filling discs
    gl_PointSize = clamp(aSize * uPixel / -mv.z, 1.0, uPixel * 0.012);
    gl_Position = projectionMatrix * mv;
  }
`;
const pointFragment = /* glsl */ `
  varying vec3 vC;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    if (dot(d, d) > 0.25) discard;
    gl_FragColor = vec4(vC, 1.0);
  }
`;
function points(geometry, { mode = 0, trail = 0.8, reveal = true, dim = 1, window = 2 } = {}) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uNow: { value: 1 }, uPixel: { value: 500 }, uMode: { value: mode },
      uTrail: { value: trail }, uReveal: { value: reveal ? 1 : 0 }, uDim: { value: dim }, uWindow: { value: window },
    },
    vertexShader: pointVertex,
    fragmentShader: pointFragment,
  });
  const cloud = new THREE.Points(geometry, material);
  cloud.frustumCulled = false;
  return cloud;
}

const texture = (img) => {
  const t = new THREE.Texture(img);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
};

// a cut-out cropped to its own box, for strips and sprites
function crop(i, pad = 0.01) {
  const [x0, y0, x1, y1] = frames[i].box;
  const sx = Math.max(0, (x0 - pad) * W), sy = Math.max(0, (y0 - pad) * H);
  const sw = Math.min(W - sx, (x1 - x0 + 2 * pad) * W), sh = Math.min(H - sy, (y1 - y0 + 2 * pad) * H);
  const c = document.createElement("canvas");
  c.width = Math.round(sw);
  c.height = Math.round(sh);
  c.getContext("2d").drawImage(cuts[i], sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}

// ── View scaffolding ─────────────────────────────────────────────────────

const views = [];
const panelOf = (name) => document.querySelector(`[data-view="${name}"]`);
const size = new THREE.Vector2();

// The lifted scene is a shell seen from the lens side, so free spinning shows
// its empty back. Views over it instead sway across a side-on arc, facing the
// animal's path square-on, until someone drags.
const side = new THREE.Vector3(-travel.z, 0, travel.x).normalize();
if (side.z < 0) side.negate(); // keep to the lens side of the scene
function sway(view, target, radius, lift) {
  view.controls.autoRotate = false;
  view.controls.target.copy(target);
  let touched = false;
  view.controls.addEventListener("start", () => { touched = true; });
  const pos = new THREE.Vector3();
  view.tick = () => {
    if (touched) return;
    const a = Math.sin(performance.now() / 7000) * 0.55;
    pos.copy(side).applyAxisAngle(new THREE.Vector3(0, 1, 0), a).multiplyScalar(radius);
    view.camera.position.copy(target).add(pos).add(new THREE.Vector3(0, lift, 0));
  };
  view.tick();
}

function glView(name, { fov = 45, orbit = true } = {}) {
  const panel = panelOf(name);
  const canvas = panel.querySelector("canvas");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050403);
  const camera = new THREE.PerspectiveCamera(fov, 16 / 9, 0.05, 400);
  const view = { name, panel, canvas, renderer, scene, camera, pixel: 500, visible: false, gl: true };
  view.fit = () => {
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    camera.aspect = canvas.clientWidth / canvas.clientHeight;
    camera.updateProjectionMatrix();
    view.pixel = renderer.getDrawingBufferSize(size).y / (2 * Math.tan(THREE.MathUtils.degToRad(fov) / 2));
  };
  new ResizeObserver(view.fit).observe(canvas);
  if (orbit) {
    view.controls = new OrbitControls(camera, canvas);
    view.controls.enableDamping = true;
    view.controls.autoRotate = true;
    view.controls.autoRotateSpeed = 0.5;
    view.controls.addEventListener("start", () => { view.controls.autoRotate = false; });
  }
  views.push(view);
  return view;
}

function canvasView(name, draw) {
  const panel = panelOf(name);
  const canvas = panel.querySelector("canvas");
  canvas.width = 960;
  canvas.height = 540;
  const view = { name, panel, canvas, ctx: canvas.getContext("2d"), draw, visible: false };
  views.push(view);
  return view;
}

const syncPoints = (view, list, now) => list.forEach((p) => {
  p.material.uniforms.uNow.value = now;
  p.material.uniforms.uPixel.value = view.pixel;
});

// ── 01 Millipede ─────────────────────────────────────────────────────────

{
  const v = glView("millipede", { fov: 42 });
  const clouds1 = [points(clouds.plate, { reveal: false, dim: 0.42 }), points(clouds.subject, { trail: 1.05 })];
  clouds1.forEach((c) => v.scene.add(c));

  // the recording camera: frustum lines and a pane carrying its live frame
  const near = 1.2;
  const w = TX * near, h = TY * near;
  const corners = [[-w, h], [w, h], [w, -h], [-w, -h]].map(([x, y]) => new THREE.Vector3(x, y, -near));
  const lines = [];
  corners.forEach((c, i) => lines.push(new THREE.Vector3(), c, c, corners[(i + 1) % 4]));
  v.scene.add(new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints(lines),
    new THREE.LineBasicMaterial({ color: 0x9fc4ff, transparent: true, opacity: 0.8 })
  ));
  const paneTexture = texture(srcs[0]);
  const pane = new THREE.Mesh(
    new THREE.PlaneGeometry(2 * w, 2 * h),
    new THREE.MeshBasicMaterial({ map: paneTexture, transparent: true, opacity: 0.85, side: THREE.DoubleSide })
  );
  pane.position.z = -near;
  v.scene.add(pane);

  // side-on to the trail and a little above, so the lens, its frustum and the
  // whole trail share the frame, as in the reference
  sway(v, pathCentre.clone().multiplyScalar(0.75), reach * 2.6 + 2, reach * 1.1 + 0.8);
  let shown = -1;
  v.render = (T) => {
    syncPoints(v, clouds1, norm(T));
    const idx = clamp(Math.round(T * fps), 0, srcCount - 1);
    if (idx !== shown) {
      paneTexture.image = srcs[idx];
      paneTexture.needsUpdate = true;
      shown = idx;
    }
  };
}

// ── 02 Scroll follows the motion ─────────────────────────────────────────

{
  const v = glView("direction", { fov: 55, orbit: false });
  // only the last few frames of trail: a chase camera sits where the trail is
  const clouds2 = [points(clouds.plate, { reveal: false, dim: 0.75 }), points(clouds.subject, { trail: 0.45, window: 0.12 })];
  clouds2.forEach((c) => v.scene.add(c));
  const overall = travel.clone().normalize();
  let p = 0;
  let target = 0;
  let idle = 0;
  v.canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    target = clamp(target + event.deltaY * 0.0007, 0, 1);
    idle = 0;
  }, { passive: false });

  const eye = new THREE.Vector3();
  const look = new THREE.Vector3();
  const dist = Math.max(2.4, reach);
  const up = new THREE.Vector3(0, 1, 0);
  const hud = document.querySelector("#dirHud");
  v.render = (T, dt) => {
    idle += dt;
    if (idle > 4) target = (target + dt * 0.08) % 1; // keep the grid alive when nobody is scrolling
    p += (target - p) * Math.min(1, dt * 5);
    // the local heading, steadied by the overall heading
    const here = pathAt(p);
    const heading = pathAt(p + 0.06).sub(pathAt(p - 0.06)).normalize().lerp(overall, 0.55).normalize();
    const side = heading.clone().cross(up).normalize();
    eye.copy(here).addScaledVector(heading, -dist).addScaledVector(up, dist * 0.6).addScaledVector(side, dist * 0.45);
    if (!v.started) { v.camera.position.copy(eye); v.started = true; }
    v.camera.position.lerp(eye, Math.min(1, dt * 4));
    look.copy(here).addScaledVector(heading, dist * 0.5);
    v.camera.lookAt(look);
    syncPoints(v, clouds2, p);
    hud.innerHTML =
      `<b>${verdict}</b>\n` +
      `depth  ${(-start.z).toFixed(1)} → ${(-end.z).toFixed(1)} u   size ×${growth.toFixed(2)}\n` +
      `scroll ↓  moves you ${toward ? "toward the lens" : away ? "away from the lens" : "across the frame"}, with the bear\n` +
      `t ${(p * 100).toFixed(0).padStart(3)}%`;
  };
}

// ── 03 Rotate time into space ────────────────────────────────────────────

{
  const v = glView("rotate", { orbit: false });
  const VW = 256, VH = 144;
  const vol = new Uint8Array(VW * VH * srcCount * 4);
  srcs.forEach((img, z) => vol.set(pixels(img, VW, VH), z * VW * VH * 4));
  const volume = new THREE.Data3DTexture(vol, VW, VH, srcCount);
  volume.minFilter = volume.magFilter = THREE.LinearFilter;
  volume.unpackAlignment = 1;
  volume.needsUpdate = true;

  const uniforms = { uVol: { value: volume }, uAngle: { value: 0 }, uT: { value: 0 }, uAxis: { value: 0 } };
  const quad = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms,
      vertexShader: /* glsl */ `
        out vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        precision highp sampler3D;
        uniform sampler3D uVol;
        uniform float uAngle, uT;
        uniform int uAxis;
        in vec2 vUv;
        out vec4 outColor;
        void main() {
          vec2 p = vUv - 0.5;
          float s = uAxis == 0 ? p.x : -p.y;
          float along = 0.5 + s * cos(uAngle);
          float t = mix(uT, 0.5, sin(uAngle)) + s * sin(uAngle);
          vec3 c = uAxis == 0 ? vec3(along, (1.0 - vUv.y) * 0.9, t) : vec3(vUv.x, along * 0.9, t);
          if (t < 0.0 || t > 1.0 || along < 0.0 || along > 1.0) { outColor = vec4(0.03, 0.025, 0.02, 1.0); return; }
          outColor = texture(uVol, c);
        }
      `,
    })
  );
  quad.frustumCulled = false;
  v.scene.add(quad);

  let angle = 0, target = 0, idle = 99;
  v.canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    target = clamp(target + event.deltaY * 0.002, 0, Math.PI / 2);
    idle = 0;
  }, { passive: false });
  v.canvas.addEventListener("click", () => { uniforms.uAxis.value ^= 1; });
  const hud = document.querySelector("#rotHud");
  v.render = (T, dt) => {
    idle += dt;
    if (idle > 5) target = (Math.PI / 4) * (1 - Math.cos(performance.now() / 3200));
    angle += (target - angle) * Math.min(1, dt * 6);
    uniforms.uAngle.value = angle;
    uniforms.uT.value = T / DUR;
    const deg = THREE.MathUtils.radToDeg(angle);
    hud.innerHTML = `<b>${deg.toFixed(0)}°</b> ${uniforms.uAxis.value ? "y" : "x"} ↔ t\n${deg < 20 ? "a picture" : deg > 70 ? "a timeline" : "half picture, half timeline"}`;
  };
}

// ── 04 Space-time block ──────────────────────────────────────────────────

{
  const v = glView("block", { fov: 40 });
  const PW = 16, PH = 9, DEPTH = 16;
  const slices = frames.map((f, i) => {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(PW, PH),
      new THREE.MeshBasicMaterial({ map: texture(cuts[i]), transparent: true, depthWrite: false, side: THREE.DoubleSide })
    );
    mesh.position.z = (f.u - 1) * DEPTH;
    mesh.renderOrder = i + 1;
    v.scene.add(mesh);
    return mesh;
  });
  const back = new THREE.Mesh(
    new THREE.PlaneGeometry(PW, PH),
    new THREE.MeshBasicMaterial({ map: texture(plate), transparent: true, opacity: 0.45, depthWrite: false })
  );
  back.position.z = -DEPTH - 0.3;
  v.scene.add(back);
  v.scene.add(new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(PW, PH, DEPTH)).translate(0, 0, -DEPTH / 2),
    new THREE.LineBasicMaterial({ color: 0xffd9a8, transparent: true, opacity: 0.18 })
  ));
  v.controls.target.set(0, 0, -DEPTH / 2);
  v.camera.position.set(19, 9, 11);
  v.render = (T) => {
    const now = norm(T);
    slices.forEach((mesh, i) => {
      const age = now - frames[i].u;
      mesh.visible = age >= -1e-4;
      mesh.material.opacity = age < 0.015 ? 1 : 0.12 + 0.5 * (1 - age);
    });
  };
}

// ── 05 Worldline ─────────────────────────────────────────────────────────

{
  const v = glView("worldline", { fov: 40 });
  const TH = reach * 1.8;
  const lift = (i) => new THREE.Vector3(path[i].x - pathCentre.x, frames[i].u * TH, path[i].z - pathCentre.z);
  const pts = frames.map((_, i) => lift(i));
  const curve = new THREE.CatmullRomCurve3(pts);
  v.scene.add(new THREE.Mesh(
    new THREE.TubeGeometry(curve, 240, reach * 0.018, 8),
    new THREE.MeshBasicMaterial({ color: 0xffd9a8 })
  ));
  // its shadow on the ground: where the bear went, without when
  const shadow = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(curve.getPoints(200).map((p) => new THREE.Vector3(p.x, 0, p.z))),
    new THREE.LineDashedMaterial({ color: 0x8a7f6a, dashSize: reach * 0.04, gapSize: reach * 0.03 })
  );
  shadow.computeLineDistances();
  v.scene.add(shadow);
  const grid = new THREE.GridHelper(reach * 3, 12, 0x3a342a, 0x221f19);
  v.scene.add(grid);

  // poses hung on the line every eighth frame
  for (let i = 0; i < N; i += 8) {
    const f = frames[i];
    const z = -path[i].z;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture(crop(i)), transparent: true, depthWrite: false }));
    sprite.scale.set((f.box[2] - f.box[0]) * 2 * TX * z, (f.box[3] - f.box[1]) * 2 * TY * z, 1).multiplyScalar(0.6);
    sprite.position.copy(pts[i]);
    v.scene.add(sprite);
  }

  const axis = (from, to, color) => v.scene.add(new THREE.ArrowHelper(to.clone().sub(from).normalize(), from, from.distanceTo(to), color, reach * 0.08, reach * 0.04));
  const o = new THREE.Vector3(-reach * 0.9, 0, reach * 0.9);
  axis(o, o.clone().add(new THREE.Vector3(0, TH * 1.1, 0)), 0xffd9a8);
  axis(o, o.clone().add(new THREE.Vector3(reach * 0.7, 0, 0)), 0x6f685a);
  axis(o, o.clone().add(new THREE.Vector3(0, 0, -reach * 0.7)), 0x6f685a);
  const label = (text, at) => {
    const c = document.createElement("canvas");
    c.width = 256; c.height = 64;
    const g = c.getContext("2d");
    g.font = "500 30px JetBrains Mono, monospace";
    g.fillStyle = "#ffd9a8";
    g.fillText(text, 6, 42);
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture(c), transparent: true, depthWrite: false }));
    s.scale.set(reach * 0.5, reach * 0.125, 1);
    s.position.copy(at);
    v.scene.add(s);
  };
  label("time", o.clone().add(new THREE.Vector3(reach * 0.2, TH * 1.18, 0)));
  label("x", o.clone().add(new THREE.Vector3(reach * 0.85, 0, 0)));
  label("depth", o.clone().add(new THREE.Vector3(reach * 0.2, 0, -reach * 0.85)));

  const present = new THREE.Mesh(
    new THREE.PlaneGeometry(reach * 3, reach * 3).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffd9a8, transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false })
  );
  const bead = new THREE.Mesh(new THREE.SphereGeometry(reach * 0.05, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  v.scene.add(present, bead);
  v.controls.target.set(0, TH * 0.5, 0);
  v.camera.position.set(reach * 2.4, TH * 0.9, reach * 2.6);
  v.render = (T) => {
    const now = norm(T);
    present.position.y = now * TH;
    bead.position.copy(curve.getPointAt(now));
  };
}

// ── 06 Colour is time ────────────────────────────────────────────────────

{
  const v = glView("timecolor", { fov: 42 });
  const clouds6 = [points(clouds.plate, { reveal: false, mode: 2, dim: 0.55 }), points(clouds.subject, { reveal: false, mode: 1 })];
  clouds6.forEach((c) => v.scene.add(c));
  sway(v, pathCentre, reach * 2.2 + 1.5, reach * 1.2 + 0.5);
  v.render = (T) => syncPoints(v, clouds6, norm(T));
}

// ── 07 Slit-scan ─────────────────────────────────────────────────────────

{
  const SW = 256, SH = 144;
  const small = srcs.map((img) => pixels(img, SW, SH));
  const xt = new ImageData(srcCount, SH);
  const yt = new ImageData(SW, srcCount);
  const xtCanvas = Object.assign(document.createElement("canvas"), { width: srcCount, height: SH });
  const ytCanvas = Object.assign(document.createElement("canvas"), { width: SW, height: srcCount });
  let lx = 0.5, ly = 0.5, hover = false, built = "";
  const FW = 576, FH = 324; // frame area; x-t sits right of it, y-t below it

  const view = canvasView("slitscan", (ctx, T) => {
    if (!hover) {
      const s = performance.now() / 1000;
      lx = 0.5 + 0.38 * Math.sin(s * 0.23);
      ly = 0.45 + 0.3 * Math.sin(s * 0.17 + 1);
    }
    const col = clamp(Math.floor(lx * SW), 0, SW - 1);
    const row = clamp(Math.floor(ly * SH), 0, SH - 1);
    if (built !== `${col},${row}`) {
      for (let t = 0; t < srcCount; t++) {
        const px = small[t];
        for (let y = 0; y < SH; y++) xt.data.set(px.subarray((y * SW + col) * 4, (y * SW + col) * 4 + 4), (y * srcCount + t) * 4);
        yt.data.set(px.subarray(row * SW * 4, (row + 1) * SW * 4), t * SW * 4);
      }
      xtCanvas.getContext("2d").putImageData(xt, 0, 0);
      ytCanvas.getContext("2d").putImageData(yt, 0, 0);
      built = `${col},${row}`;
    }
    const idx = clamp(Math.round(T * fps), 0, srcCount - 1);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, 960, 540);
    ctx.drawImage(srcs[idx], 0, 0, FW, FH);
    ctx.drawImage(xtCanvas, FW + 4, 0, 960 - FW - 4, FH);
    ctx.drawImage(ytCanvas, 0, FH + 4, FW, 540 - FH - 4);
    ctx.strokeStyle = "rgba(255,217,168,0.9)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(lx * FW, 0); ctx.lineTo(lx * FW, FH);
    ctx.moveTo(0, ly * FH); ctx.lineTo(FW, ly * FH);
    // the present on each timeline
    const tx = FW + 4 + (idx / (srcCount - 1)) * (960 - FW - 4);
    const ty = FH + 4 + (idx / (srcCount - 1)) * (540 - FH - 4);
    ctx.moveTo(tx, 0); ctx.lineTo(tx, FH);
    ctx.moveTo(0, ty); ctx.lineTo(FW, ty);
    ctx.stroke();
    ctx.font = "13px JetBrains Mono, monospace";
    ctx.fillStyle = "#ffd9a8";
    ctx.fillText("column over time →", FW + 12, 20);
    ctx.fillText("row over time ↓", 8, FH + 22);
    ctx.fillText("x, y", FW + 12, FH + 34);
    ctx.fillStyle = "#a9a08c";
    ctx.fillText("the picture", FW + 12, FH + 54);
    ctx.fillText("sliced both ways", FW + 12, FH + 72);
  });
  view.canvas.addEventListener("pointermove", (event) => {
    const r = view.canvas.getBoundingClientRect();
    const x = ((event.clientX - r.left) / r.width) * 960, y = ((event.clientY - r.top) / r.height) * 540;
    if (x < FW && y < FH) { lx = x / FW; ly = y / FH; hover = true; }
  });
  view.canvas.addEventListener("pointerleave", () => { hover = false; });
}

// ── 08 Chronophotograph ──────────────────────────────────────────────────

{
  const EVERY = 6;
  const strip = frames.map((_, i) => (i % EVERY === 0 ? crop(i, 0.004) : null));
  canvasView("chrono", (ctx, T) => {
    const now = norm(T);
    ctx.drawImage(plate, 0, 0, 960, 540);
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.fillRect(0, 0, 960, 540);
    const shown = frames.filter((f) => f.u <= now + 1e-4);
    shown.forEach((f, i) => {
      if (i % EVERY !== 0 && i !== shown.length - 1) return;
      ctx.globalAlpha = i === shown.length - 1 ? 1 : 0.25 + 0.6 * (i / Math.max(1, shown.length - 1));
      ctx.drawImage(cuts[i], 0, 0, 960, 540);
    });
    ctx.globalAlpha = 1;
    // the strip: every pose, same height, side by side
    const band = 96, y = 540 - band - 8; // over the camera's timestamp bar
    ctx.fillStyle = "rgba(5,4,3,0.82)";
    ctx.fillRect(0, y - 8, 960, band + 16);
    const cells = strip.filter(Boolean);
    const cw = 960 / cells.length;
    cells.forEach((c, k) => {
      const i = k * EVERY;
      ctx.globalAlpha = frames[i].u <= now + 1e-4 ? 1 : 0.18;
      const s = Math.min((cw - 4) / c.width, band / c.height);
      ctx.drawImage(c, k * cw + (cw - c.width * s) / 2, y + (band - c.height * s), c.width * s, c.height * s);
    });
    ctx.globalAlpha = 1;
  });
}

// ── 09 Echo ──────────────────────────────────────────────────────────────

{
  const ECHO = 2; // seconds of trail
  canvasView("echo", (ctx, T) => {
    const idx = clamp(Math.round(T * fps), 0, srcCount - 1);
    ctx.drawImage(srcs[idx], 0, 0, 960, 540);
    frames.forEach((f, i) => {
      const age = T - f.t;
      if (age <= 0.03 || age > ECHO) return;
      ctx.globalAlpha = 0.7 * Math.pow(1 - age / ECHO, 1.6);
      ctx.drawImage(cuts[i], 0, 0, 960, 540);
    });
    ctx.globalAlpha = 1;
  });
}

// ── Clock and loop ───────────────────────────────────────────────────────

const io = new IntersectionObserver((entries) => entries.forEach((e) => {
  const view = views.find((v) => v.panel === e.target);
  if (view) view.visible = e.isIntersecting;
}));
views.forEach((v) => io.observe(v.panel));

const scrub = document.querySelector("#scrub");
const clock = document.querySelector("#clock");
const play = document.querySelector("#play");
let T = 0;
let playing = true;
play.addEventListener("click", () => {
  playing = !playing;
  play.textContent = playing ? "❚❚" : "▶";
});
scrub.addEventListener("input", () => { T = Number(scrub.value) * DUR; });

let last = performance.now();
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (playing) T = (T + dt) % (DUR + 1); // a beat of hold at the end
  const t = Math.min(T, DUR);
  scrub.value = t / DUR;
  clock.textContent = `${t.toFixed(2)}s`;
  for (const v of views) {
    if (!v.visible) continue;
    if (v.gl) {
      v.render(t, dt);
      v.tick?.();
      v.controls?.update();
      v.renderer.render(v.scene, v.camera);
    } else {
      v.draw(v.ctx, t);
    }
  }
}
requestAnimationFrame(loop);
window.__lab = { verdict, growth, depthRatio, start, end, points: clouds.subject.attributes.position.count };
