import * as THREE from "three";
import { OrbitControls } from "./vendor/three/examples/jsm/controls/OrbitControls.js";

// Lite: every tracked frame of the subject as a cut-out, stacked along time into a spacetime solid on black.
// Scroll over it = move through time, drag = turn it (right-drag pans), the frame being played is in full colour.
const SPAN = 2.6;                // length of the time axis, in picture heights
const GHOSTS = 150;              // at most this many frames are kept as ghosts; the played frame is always the exact one
const image = url => { const img = new Image(); img.crossOrigin = "anonymous"; img.src = url; return img.decode().then(() => img); };

export async function createLiteView(root, result, api = "", { maxGhosts = GHOSTS, label = "", trailOnly = false, trailPlayback = false } = {}) {
  const url = value => /^https?:/.test(value) ? value : api + value;
  const cuts = result.ghosts.map((g, i) => ({ ...g, sample: g.sample ?? i, track: g.track ?? 1 })).sort((a, b) => a.sample - b.sample);
  const samples = Math.max(1, result.samples || 0, ...cuts.map(g => g.sample + 1));
  root.innerHTML = `<div class="lite-canvas"><canvas aria-label="Spacetime solid of the tracked subject"></canvas><p class="lite-load"></p></div><div class="lite-controls"><button type="button" class="lite-play">Play</button><label>Frame <input class="lite-scrub" type="range" min="0" max="${samples - 1}" value="${samples - 1}"></label><output></output><button type="button" class="lite-reset">Reset view</button><button type="button" class="lite-front" title="Look straight along time: the picture as the camera saw it, trail and direction on top">Front view</button></div><ul class="heads lite-numbers"></ul><p class="note">Every tracked frame is stacked along time, blue = earliest, gold = latest. The gold arrow is where the subject is heading right now. Scroll to move through it, drag to turn the whole solid, right-drag to move it. The frame being played is in full colour.</p>`;
  const box = root.querySelector(".lite-canvas"), canvas = root.querySelector("canvas"), loading = root.querySelector(".lite-load");
  const scrub = root.querySelector(".lite-scrub"), output = root.querySelector("output"), numbers = root.querySelector(".lite-numbers"), play = root.querySelector(".lite-play");
  const inputs = [...root.querySelectorAll(".lite-controls button, .lite-controls input")];
  for (const input of inputs) input.disabled = true;
  const aspect = result.width / result.height, W = 2 * aspect, H = 2;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.setClearColor(0x000000);
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(38, 1.6, 0.05, 80);
  const heads = new Map(), cache = new Map();
  let dirty = true, timer = null, playToken = 0, disposed = false, controls, resize, raf;
  function dispose() {
    if (disposed) return;
    disposed = true; playToken++; clearTimeout(timer); cancelAnimationFrame(raf);
    resize?.disconnect(); controls?.dispose();
    for (const input of inputs) input.disabled = true;
    const resources = new Set();
    scene.traverse(object => {
      if (object.geometry) resources.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (!material) continue;
        resources.add(material); if (material.map) resources.add(material.map);
      }
    });
    for (const resource of resources) resource.dispose();
    scene.clear(); cache.clear(); heads.clear(); renderer.dispose();
  }
  function checkConnected() {
    if (disposed || !canvas.isConnected) { dispose(); throw new Error("Viewer was replaced during loading."); }
  }
  const COOL = new THREE.Color(0x3c8cff), WARM = new THREE.Color(0xffe08a);
  const timeTint = sample => COOL.clone().lerp(WARM, sample / Math.max(1, samples - 1));      // the trail reads old -> new, so the direction of travel is visible
  const zOf = sample => (sample / Math.max(1, samples - 1)) * SPAN;
  const place = cut => { const [l, t, r, b] = cut.box; return { x: ((l + r) / 2 - 0.5) * W, y: (0.5 - (t + b) / 2) * H, w: (r - l) * W, h: (b - t) * H, z: zOf(cut.sample) }; };

  // ghosts: a pale, small copy of every Nth frame
  const stride = Math.max(1, Math.ceil(cuts.length / maxGhosts)), ghosts = [];
  const picked = cuts.filter((_, i) => i % stride === 0);
  let done = 0, next = 0;
  try { await Promise.all(Array.from({ length: Math.min(8, picked.length) }, async () => {
    while (!disposed && next < picked.length) {
      const cut = picked[next++], img = await image(url(cut.url)), k = Math.min(1, 256 / Math.max(img.width, img.height));
      checkConnected();
      const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
      const cg = c.getContext("2d"); cg.filter = "grayscale(1) brightness(1.8)"; cg.drawImage(img, 0, 0, c.width, c.height);
      const p = place(cut), mesh = new THREE.Mesh(new THREE.PlaneGeometry(p.w, p.h), new THREE.MeshBasicMaterial({ map: Object.assign(new THREE.CanvasTexture(c), { colorSpace: THREE.SRGBColorSpace }), color: timeTint(cut.sample), transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide }));
      mesh.position.set(p.x, p.y, p.z); mesh.renderOrder = cut.sample; mesh.userData = { sample: cut.sample, track: cut.track };
      ghosts.push(mesh); scene.add(mesh); loading.textContent = `Stacking frames… ${++done} / ${picked.length}`;
    }
  })); } catch (error) { dispose(); throw error; }
  checkConnected();

  // the world line: where the subject stood, frame after frame
  const tracks = new Map(); for (const cut of cuts) { if (!tracks.has(cut.track)) tracks.set(cut.track, []); tracks.get(cut.track).push(cut); }
  const colours = [0xffc828, 0x3cdcff, 0xff5aa0];
  if (!trailOnly && !trailPlayback) [...tracks.values()].forEach((list, i) => {
    const pts = list.map(c => { const p = place(c); return new THREE.Vector3(p.x, p.y - p.h * 0.45, p.z); });
    scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: colours[i % colours.length], transparent: true, opacity: 0.9 })));
  });
  // the picture plane at the moment being played
  const frameOutline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => new THREE.Vector3(a * W / 2, b * H / 2, 0))), new THREE.LineBasicMaterial({ color: 0x4a5a60 }));
  frameOutline.visible = !trailPlayback;
  scene.add(frameOutline);
  // time runs along z: an axis with its two ends named
  const axisLabel = (text, colour) => { const c = document.createElement("canvas"); c.width = 256; c.height = 64; const cg = c.getContext("2d"); cg.font = "600 30px monospace"; cg.fillStyle = colour; cg.textAlign = "center"; cg.fillText(text, 128, 44); const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthTest: false })); sp.scale.set(0.9, 0.225, 1); sp.renderOrder = 200000; return sp; };
  const axisX = -W / 2 - 0.15, axisY = -H / 2 - 0.1;
  if (!trailPlayback) scene.add(new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(axisX, axisY, 0), SPAN, 0x6d86a0, 0.14, 0.07));
  if (!trailPlayback) { const tStart = axisLabel("start", "#7ab0ff"), tEnd = axisLabel("later", "#ffe08a"); tStart.position.set(axisX, axisY - 0.18, 0); tEnd.position.set(axisX, axisY - 0.18, SPAN); scene.add(tStart, tEnd); }
  // the direction the subject is travelling in the picture, right now
  const dirArrows = new Map();
  const dirArrow = track => { if (!dirArrows.has(track)) { const a = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 1, 0xffc828, 0.22, 0.14); a.line.material.depthTest = false; a.cone.material.depthTest = false; a.renderOrder = 300000; a.line.renderOrder = a.cone.renderOrder = 300000; scene.add(a); dirArrows.set(track, a); } return dirArrows.get(track); };

  // the frame being played: the exact cut-out, in its own colours, with a thin glow behind it
  const load = cut => {
    if (!cache.has(cut.url)) {
      const pending = image(url(cut.url));
      cache.set(cut.url, pending);
      pending.catch(() => { if (cache.get(cut.url) === pending) cache.delete(cut.url); });
      if (cache.size > 40) cache.delete(cache.keys().next().value);
    }
    return cache.get(cut.url);
  };
  const headOf = track => {
    if (heads.has(track)) return heads.get(track);
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ transparent: true, color: 0xffc828, opacity: 0.6, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    const body = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ transparent: true, opacity: 1, depthWrite: false, side: THREE.DoubleSide })); body.renderOrder = 100000; glow.renderOrder = 99999;
    scene.add(glow, body); const head = { body, glow, url: null }; heads.set(track, head); return head;
  };
  async function setHead(track, cut) {
    if (disposed) return;
    const head = headOf(track); if (!cut) { head.url = null; head.body.visible = head.glow.visible = false; return; }
    head.url = cut.url;
    const img = await load(cut); if (disposed || head.url !== cut.url) return;
    if (head.textureUrl !== cut.url) {
      head.textureUrl = cut.url;
      head.body.material.map?.dispose(); head.body.material.map = new THREE.Texture(img); head.body.material.map.colorSpace = THREE.SRGBColorSpace; head.body.material.map.needsUpdate = true; head.body.material.needsUpdate = true;
      const sil = document.createElement("canvas"); sil.width = img.width; sil.height = img.height; const sg = sil.getContext("2d"); sg.drawImage(img, 0, 0); sg.globalCompositeOperation = "source-in"; sg.fillStyle = "#fff"; sg.fillRect(0, 0, sil.width, sil.height);
      head.glow.material.map?.dispose(); head.glow.material.map = new THREE.CanvasTexture(sil); head.glow.material.needsUpdate = true;
    }
    // Move the pose only when its image is ready, never the previous image at a new position.
    const p = place(cut); head.sample = head.textureSample = cut.sample; head.body.visible = true; head.glow.visible = !trailPlayback;
    head.body.scale.set(p.w, p.h, 1); head.glow.scale.set(p.w * 1.07, p.h * 1.07, 1);
    head.body.position.set(p.x, p.y, p.z + 0.004); head.glow.position.set(p.x, p.y, p.z); dirty = true;
  }

  // frame the subject, not the whole picture: the bounds of every cut-out, over the whole time axis
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const cut of cuts) { const p = place(cut); x0 = Math.min(x0, p.x - p.w / 2); x1 = Math.max(x1, p.x + p.w / 2); y0 = Math.min(y0, p.y - p.h / 2); y1 = Math.max(y1, p.y + p.h / 2); }
  if (!Number.isFinite(x0)) { x0 = -W / 2; x1 = W / 2; y0 = -H / 2; y1 = H / 2; }
  const centre = new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, SPAN / 2), radius = Math.hypot(x1 - x0, y1 - y0, SPAN) / 2;
  const home = centre.clone().add(new THREE.Vector3(0.8, 0.35, 1).normalize().multiplyScalar(radius / Math.tan(THREE.MathUtils.degToRad(19)) * 0.6));
  camera.position.copy(home);
  controls = new OrbitControls(camera, canvas); controls.target.copy(centre); controls.enableDamping = true; controls.dampingFactor = 0.1; controls.enableZoom = false;
  // the cut-outs are flat, so the solid turns as one rigid piece, within the angles where they stay readable
  controls.minAzimuthAngle = -1.05; controls.maxAzimuthAngle = 1.05; controls.minPolarAngle = 0.6; controls.maxPolarAngle = 2.1; controls.update();
  controls.addEventListener("change", () => { dirty = true; });
  root.querySelector(".lite-front").addEventListener("click", () => { camera.position.set(centre.x, centre.y, SPAN + radius / Math.tan(THREE.MathUtils.degToRad(19)) * 0.55); controls.target.set(centre.x, centre.y, SPAN / 2); controls.update(); dirty = true; });
  root.querySelector(".lite-reset").addEventListener("click", () => { camera.position.copy(home); controls.target.copy(centre); controls.update(); dirty = true; });

  function show() {
    if (disposed) return Promise.resolve();
    const frame = Number(scrub.value); dirty = true;
    if (trailOnly) {
      for (const g of ghosts) { g.visible = true; g.material.opacity = 0.12; }
      frameOutline.visible = false;
      output.textContent = `${ghosts.length} retained poses`;
      return Promise.resolve();
    }
    for (const g of ghosts) { const past = g.userData.sample < frame; g.material.opacity = trailPlayback || past ? 0.12 : 0.03; g.visible = g.userData.sample !== frame; }
    frameOutline.position.z = zOf(frame);
    numbers.replaceChildren(); let i = 0; const updates = [];
    for (const [track, list] of tracks) {
      let lo = 0, hi = list.length - 1, at = -1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (list[mid].sample <= frame) { at = mid; lo = mid + 1; } else hi = mid - 1; }
      updates.push(setHead(track, at >= 0 ? list[at] : null));
      const arrow = dirArrow(track); arrow.visible = false;
      if (at >= 0) {
        const a = place(list[0]), b = place(list[at]), dx = (b.x - a.x) / W * result.width, dy = -(b.y - a.y) / H * result.height;
        // direction over the last stretch of frames (a second or so), so it follows turns instead of the whole trip
        const back = place(list[Math.max(0, at - Math.round((result.fps || 15) * 1.2))]), vx = b.x - back.x, vy = b.y - back.y, speed = Math.hypot(vx, vy);
        if (speed > 0.02 && !trailPlayback) { arrow.visible = true; arrow.position.set(b.x, b.y, b.z + 0.01); arrow.setDirection(new THREE.Vector3(vx, vy, 0).normalize()); arrow.setLength(Math.min(1.1, 0.5 + speed * 2), 0.22, 0.14); }
        const word = (px, neg, pos) => Math.abs(px) < 8 ? "" : px > 0 ? pos : neg;
        const dir = [word(dx, "left", "right"), word(dy, "down", "up")].filter(Boolean).join(" and ") || "standing about";
        const size = b.h / Math.max(a.h, 1e-6), depth = size < 0.8 ? ` · getting smaller (${Math.round(size * 100)}%): moving away` : size > 1.25 ? ` · getting bigger (${Math.round(size * 100)}%): coming closer` : "";
        const li = document.createElement("li"); li.textContent = `Subject ${++i}: moving ${dir} in the picture${depth} · ${Math.hypot(dx, dy).toFixed(0)} px so far · ${at + 1} frames tracked`; numbers.append(li);
      }
    }
    output.textContent = `${frame + 1} / ${samples}${result.fps ? ` · ${(frame / result.fps).toFixed(1)} s` : ""}`;
    return Promise.all(updates);
  }
  const seek = f => { scrub.value = Math.max(0, Math.min(samples - 1, f)); return show(); };
  const stop = () => { playToken++; clearTimeout(timer); timer = null; play.textContent = "Play"; };
  const frameError = () => { stop(); output.textContent = "Could not load this pose."; };
  scrub.addEventListener("input", () => { stop(); show().catch(frameError); });
  canvas.addEventListener("wheel", e => { e.preventDefault(); stop(); const step = Math.max(1, Math.round(samples / 120)); seek(Number(scrub.value) + Math.sign(e.deltaY) * step * Math.max(1, Math.min(4, Math.abs(e.deltaY) / 100))).catch(frameError); }, { passive: false });
  play.addEventListener("click", () => {
    if (timer !== null) return stop();
    const token = ++playToken;
    play.textContent = "Pause";
    const advance = async (restart = false) => {
      if (token !== playToken || disposed || !canvas.isConnected) return;
      const started = performance.now();
      try {
        if (restart) await seek(0);
        else if (Number(scrub.value) >= samples - 1) return stop();
        else await seek(Number(scrub.value) + 1);
      } catch { if (token === playToken) frameError(); return; }
      // Wait for the actual texture. Concurrent seeks can otherwise keep
      // invalidating slow image loads and leave one old pose on screen.
      if (token === playToken) timer = setTimeout(advance, Math.max(0, 1000 / (result.fps || 15) - (performance.now() - started)));
    };
    timer = setTimeout(() => advance(Number(scrub.value) >= samples - 1), 0);
  });

  const fit = () => { const w = box.clientWidth || 640, h = Math.round(w * 0.62); renderer.setSize(w, h, false); canvas.style.height = `${h}px`; camera.aspect = w / h; camera.updateProjectionMatrix(); dirty = true; };
  resize = new ResizeObserver(fit); resize.observe(box); fit();
  try { await show(); checkConnected(); } catch (error) { loading.textContent = "Could not load this viewer."; dispose(); throw error; }
  loading.remove();
  for (const input of inputs) input.disabled = false;
  (function loop() { if (disposed || !canvas.isConnected) { dispose(); return; } if (controls.update() || dirty) { dirty = false; renderer.render(scene, camera); } raf = requestAnimationFrame(loop); })();
  // Offline capture waits for the selected texture instead of recording the previous frame at its new position.
  return {
    dispose,
    seek: async frame => { await seek(frame); if (!disposed) { controls.update(); renderer.render(scene, camera); } }, samples, fps: result.fps || 15,
    ghostSamples: ghosts.map(g => g.userData.sample).sort((a, b) => a - b),
    frameState: () => [...heads.values()].filter(h => h.body.visible).map(h => ({ sample: h.sample, textureSample: h.textureSample, opacity: h.body.material.opacity, loaded: !!h.body.material.map && h.textureSample === h.sample, position: h.body.position.toArray(), glow: h.glow.visible })), 
    view: () => ({ position: camera.position.toArray(), target: controls.target.toArray() }),
    setView: view => { if (disposed) return; camera.position.fromArray(view.position); controls.target.fromArray(view.target); controls.update(); renderer.render(scene, camera); },
  };
}
