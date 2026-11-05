const query = new URLSearchParams(location.search), source = query.get('source') === 'muntjac' ? 'muntjac' : 'blackcat', mode = ['row', 'diagonal', 'sheet'].includes(query.get('mode')) ? query.get('mode') : 'row';
const stage = document.querySelector('#stage'), base = `/assets/gallery-seed/${source}-atlas`;
const median = a => { const s = [...a].sort((x, y) => x - y); return (s[Math.floor((s.length - 1) / 2)] + s[Math.floor(s.length / 2)]) / 2; };
try {
  const start = performance.now(), meta = await (await fetch(base + '.json')).json(), metaEnd = performance.now();
  const blob = await (await fetch(base + '.webp')).blob(), assetEnd = performance.now();
  const imageUrl = URL.createObjectURL(blob), image = new Image(); image.src = imageUrl; await image.decode(); const decodeEnd = performance.now();
  window.addEventListener('pagehide', () => URL.revokeObjectURL(imageUrl), { once: true });
  if (meta.poses.length !== meta.count || meta.timestamps.length !== meta.count) throw new Error('The identified observation list is incomplete.');
  document.querySelector('#title').textContent = source === 'blackcat' ? 'Black cat · seven observed poses' : 'Muntjac · seven observed poses';
  document.querySelector('#label').textContent = ({ row: 'Existing chrono row · all seven observations', diagonal: 'Receding diagonal · the same seven observations', sheet: '2D contact sheet · the same seven observations' })[mode];
  document.querySelector('#ids').textContent = meta.poses.map((id, i) => `frame ${id} · ${meta.timestamps[i]} s`).join(' / ');
  document.querySelector('#credit').textContent = source === 'blackcat' ? 'Black Cat walking — Dzkouslavia (CC0), Wikimedia Commons.' : 'Muntjac Deer Barking — Mvolz (CC BY 3.0), Wikimedia Commons · creativecommons.org/licenses/by/3.0/';
  const canvas = document.createElement('canvas'); stage.append(canvas);
  let draw, details, renderTimes = [];
  if (mode === 'sheet') {
    stage.style.height = 'auto'; stage.style.minHeight = '0'; stage.style.overflow = 'visible';
    document.querySelector('#label').textContent += ' · scroll for all poses on narrow screens';
    const width = stage.clientWidth, cols = width < 720 ? 2 : 4, gap = 12, cellW = (width - gap * (cols + 1)) / cols, cellH = cellW / meta.aspect + 28, rows = Math.ceil(meta.count / cols), dpr = Math.min(devicePixelRatio, 2);
    canvas.width = Math.round(width * dpr); canvas.height = Math.round((rows * (cellH + gap) + gap) * dpr); canvas.style.height = canvas.height / dpr + 'px';
    const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
    draw = () => {
      ctx.fillStyle = '#5b626a'; ctx.fillRect(0, 0, width, canvas.height / dpr);
      for (let i = 0; i < meta.count; i++) {
        const x = gap + i % cols * (cellW + gap), y = gap + Math.floor(i / cols) * (cellH + gap);
        ctx.drawImage(image, i % meta.cols * meta.cellW, Math.floor(i / meta.cols) * meta.cellH, meta.cellW, meta.cellH, x, y, cellW, cellW / meta.aspect);
        ctx.fillStyle = '#fff'; ctx.font = '12px system-ui'; ctx.fillText(`${meta.poses[i]} · ${meta.timestamps[i]} s`, x + 4, y + cellH - 8);
      }
    };
    details = { canvasDrawImages: meta.count, drawCalls: null, gpuTextures: null, renderer: 'Canvas2D; internal GPU allocation is not reported', canvasBytes: canvas.width * canvas.height * 4 };
  } else {
    const [THREE, volume, orbit] = await Promise.all([import('three'), import('/volume.js'), import('/vendor/three/examples/jsm/controls/OrbitControls.js')]);
    const texture = new THREE.Texture(image); texture.needsUpdate = true; texture.colorSpace = THREE.SRGBColorSpace; texture.minFilter = texture.magFilter = THREE.LinearFilter; texture.generateMipmaps = false;
    const group = volume.buildChronoVolume(texture, { ...meta, live: null }, { staging: false });
    if (mode === 'diagonal') {
      const layout = volume.portraitChronoPoints({ count: meta.count, poseW: group.userData.poseW, poseH: group.userData.poseH, timestamps: meta.timestamps, max: meta.count });
      volume.setChronoLayout(group, { mode: 'portrait', ...layout });
    }
    const orders = group.children.filter(m => m.userData.order !== undefined).map(m => m.userData.order).sort((a, b) => a - b);
    if (JSON.stringify(orders) !== JSON.stringify(meta.poses.map((_, i) => i))) throw new Error('A view changed observation membership.');
    group.rotation.set(.1, -.28, 0); group.updateMatrixWorld(true);
    const scene = new THREE.Scene(); scene.add(group);
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true }); renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.setClearColor('#5b626a'); renderer.setSize(stage.clientWidth, stage.clientHeight, false); canvas.style.height = stage.clientHeight + 'px';
    const camera = new THREE.PerspectiveCamera(36, stage.clientWidth / stage.clientHeight, .01, 2000), box = new THREE.Box3().setFromObject(group), size = box.getSize(new THREE.Vector3()), centre = box.getCenter(new THREE.Vector3());
    const tan = Math.tan(camera.fov * Math.PI / 360), distance = Math.max(size.y / (2 * tan * .8), size.x / (2 * tan * camera.aspect * .9)) + size.z / 2;
    camera.position.copy(centre).add(new THREE.Vector3(0, 0, distance)); camera.lookAt(centre);
    const controls = new orbit.OrbitControls(camera, canvas); controls.target.copy(centre); controls.update(); controls.addEventListener('change', () => renderer.render(scene, camera));
    const gl = renderer.getContext(), extension = gl.getExtension('WEBGL_debug_renderer_info');
    draw = () => { renderer.render(scene, camera); gl.finish(); };
    details = () => ({ drawCalls: renderer.info.render.calls, gpuTextures: renderer.info.memory.textures, geometries: renderer.info.memory.geometries, renderer: extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), synchronisedDraw: true });
    window.addEventListener('pagehide', () => { controls.dispose(); volume.disposeVolume(group); renderer.dispose(); }, { once: true });
  }
  const built = performance.now(); draw(); const firstDraw = performance.now();
  await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
  const readyToPaint = performance.now();
  for (let i = 0; i < 20; i++) { const t = performance.now(); draw(); renderTimes.push(performance.now() - t); }
  window.__metrics = { ready: true, source, mode, viewport: [innerWidth, innerHeight], poseIds: [...meta.poses], timestamps: [...meta.timestamps], identifiedCount: meta.count, documentHeight: document.documentElement.scrollHeight, unusedUnlabelledLiveCells: meta.live?.count || 0, metaMs: metaEnd - start, imageTransferMs: assetEnd - metaEnd, imageDecodeMs: decodeEnd - assetEnd, buildMs: built - decodeEnd, firstDrawMs: firstDraw - built, firstUsefulNavigationMs: readyToPaint, readinessMarker: 'Double-rAF opportunity after first draw, before repeated timing draws; not physical display scanout.', drawMedianMs: median(renderTimes), drawP95Ms: [...renderTimes].sort((a,b)=>a-b)[18], drawSamples: renderTimes, sourceBitmapBytes: image.width * image.height * 4, ...(typeof details === 'function' ? details() : details) };
} catch (error) { document.querySelector('#error').textContent = error.message; window.__error = error.stack || error.message; }
