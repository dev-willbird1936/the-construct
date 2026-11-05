import * as THREE from "three";

// ── The construct ────────────────────────────────────────────────────────
// Not boxes: bundles of fibres. Every grid line of a cubic lattice carries a
// beam, and every beam is a core wrapped in hundreds of thin bars of uneven
// relief that run its whole length, the way the film's tesseract is a room
// extruded into streaks. Beams run along x, y and z and weave through each
// other where they cross; the rooms are the windows between them.
//
// Fibre layout repeats every PERIOD cells, so the whole thing is built once
// and slid under the camera in PERIOD-cell steps without a visible pop. Colour
// is looked up from world position, so each room's walls take its own
// specimen's palette no matter where the mesh currently sits.

export const CELL = 14;             // pitch between room centres
const BEAM = 4.5;                   // beam thickness
export const OPEN = CELL - BEAM;    // clear opening of a room
export const PERIOD = 2;            // layout repeat, in cells
const SPAN = 4;                     // rooms either side of centre in x and y
const Z_NEAR = 2;                   // rooms toward the viewer
const Z_FAR = 5;                    // rooms away from the viewer
const CORE = BEAM / 2 - 0.22;       // half-width of a beam's dark core

export const latticeUniforms = {
  uTime: { value: 0 },
  uFocus: { value: new THREE.Vector3() },
  // warm haze, not black: the film's construct fades into amber light
  uFog: { value: new THREE.Color(0x2a1c0f) },
  uFogDensity: { value: 0.0175 },
  uCell: { value: CELL },
  uPalette: { value: null },
  // 0..1 during a glide: near fibres part, thread by thread, as you pass
  uNearClear: { value: 0 },
  // 1: every bar carries its hairline threads and glints; 0 on hardware that
  // cannot keep up (the bars keep their rod shading and colour)
  uDetail: { value: 1 },
  // the way in on a first visit: every fibre is drawn out from the room ahead
  // to this radius, so the construct extends itself line by line. BUILT (and
  // anything past it) skips the work entirely.
  uBuild: { value: 1e4 },
  uBuildAt: { value: new THREE.Vector3() },
};
export const BUILT = 1e4;

const vertexShader = /* glsl */ `
  attribute vec4 aData;   // seed, shade, axis, gloss
  uniform float uBuild;
  uniform vec3 uBuildAt;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec3 vLocal;
  varying vec4 vData;
  varying float vTip;
  void main() {
    vData = aData;
    vLocal = position;
    vTip = 1000.0;
    vec3 p = position;
    if (uBuild < 10000.0) {
      // a fibre is drawn outward from its point nearest the build centre; the
      // front is a sphere, so it runs along each fibre as far as the sphere
      // reaches it. Fibres the front has not touched collapse to nothing.
      int ax = int(aData.z + 0.5);
      vec3 c = (modelMatrix * instanceMatrix[3]).xyz;
      float len = ax == 0 ? length(instanceMatrix[0].xyz) : ax == 1 ? length(instanceMatrix[1].xyz) : length(instanceMatrix[2].xyz);
      float ca = ax == 0 ? c.x : ax == 1 ? c.y : c.z;
      float fa = ax == 0 ? uBuildAt.x : ax == 1 ? uBuildAt.y : uBuildAt.z;
      vec3 d = c - uBuildAt;
      float q = ax == 0 ? length(d.yz) : ax == 1 ? length(d.xz) : length(d.xy);
      float lo0 = ca - len * 0.5, hi0 = ca + len * 0.5;
      float nearest = clamp(fa, lo0, hi0);
      float reach = sqrt(max(uBuild * uBuild - q * q, 0.0));
      float lo = max(lo0, nearest - reach), hi = min(hi0, nearest + reach);
      float drawn = max(hi - lo, 0.0);
      float pa = ax == 0 ? p.x : ax == 1 ? p.y : p.z;
      float along = (mix(lo, hi, pa + 0.5) - ca) / max(len, 1e-4);
      float thick = smoothstep(0.0, 0.5, drawn);
      if (ax == 0) { p.x = along; p.yz *= thick; }
      else if (ax == 1) { p.y = along; p.xz *= thick; }
      else { p.z = along; p.xy *= thick; }
      // distance from the end still being drawn, so only its head glows
      bool growHi = hi < hi0 - 0.02, growLo = lo > lo0 + 0.02;
      vTip = !growHi && !growLo ? 1000.0 : (pa > 0.0 ? growHi : growLo) ? 0.0 : drawn;
    }
    mat4 m = modelMatrix * instanceMatrix;
    vec4 world = m * vec4(p, 1.0);
    vWorld = world.xyz;
    // instances are axis-aligned boxes, so scaling never tilts a normal
    vNormal = normalize(mat3(m) * normal);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D uPalette;
  uniform float uTime;
  uniform vec3 uFocus;
  uniform vec3 uFog;
  uniform float uFogDensity;
  uniform float uCell;
  uniform float uNearClear;
  uniform float uDetail;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec3 vLocal;
  varying vec4 vData;
  varying float vTip;

  void main() {
    #ifdef NEAR_CLEAR
    // a glide passes through the construct: fibres near the eye part thread by
    // thread, so a beam you cross is a curtain of strands, not a wall. Only the
    // glide variant carries the discard; at rest the lattice keeps early depth.
    {
      float thin = uNearClear * (1.0 - smoothstep(6.0, 16.0, length(cameraPosition - vWorld)));
      vec3 tq = floor(vWorld / 0.055);
      int ax = int(vData.z + 0.5);
      vec2 perp = ax == 0 ? tq.yz : ax == 1 ? tq.xz : tq.xy;
      if (fract(sin(dot(perp, vec2(12.9898, 78.233)) + vData.x * 91.7) * 43758.5453) < thin) discard;
    }
    #endif
    float seed = vData.x;
    float shade = vData.y;
    int axis = int(vData.z + 0.5);
    float gloss = vData.w;
    vec3 along = axis == 0 ? vec3(1.0, 0.0, 0.0) : axis == 1 ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0);

    // the room this fragment faces decides whose footage it is made of
    vec2 room = floor(vWorld.xy / uCell + 0.5);
    vec2 slot = mod(room, 3.0);
    float row = slot.x + slot.y * 3.0;
    vec3 c = texture2D(uPalette, vec2(seed, (row + 0.5) / 9.0)).rgb;

    // film grade: mostly neutral umber and bone, footage colour kept as a tint
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    vec3 ramp = mix(vec3(0.05, 0.032, 0.018), vec3(0.52, 0.37, 0.21), smoothstep(0.0, 0.4, l));
    ramp = mix(ramp, vec3(0.96, 0.87, 0.7), smoothstep(0.4, 0.9, l));
    // near the specimen the fibres keep more of its footage colour, so the
    // room reads as the object pulled out into strings
    float near = exp(-pow(length(vWorld.xy - uFocus.xy) / 11.0, 2.0));
    vec3 col = mix(c * 1.15, ramp, 0.8 - 0.42 * near);
    // a few strands are the construct's practical lights: cold and bright
    if (seed > 0.985) col = vec3(0.72, 0.86, 1.0) * 1.15;

    vec3 N = normalize(vNormal);
    vec3 V = normalize(cameraPosition - vWorld);
    vec3 L = normalize(vec3(-0.35, 0.8, 0.5));

    // fibre ends read darker than their long sides, so bundles look stepped
    float endFace = abs(dot(N, along));
    float diff = 0.34 + 0.66 * max(dot(N, L), 0.0);
    diff += 0.22 * max(dot(N, V), 0.0);
    col *= diff * shade * mix(1.0, 0.55, endFace);

    // Shade each bar as a rod, not a plank: across its width the light rolls
    // off to dark edges and peaks in a thin highlight down the middle. This is
    // what turns a bundle into lines.
    vec3 an = abs(N);
    int nAxis = an.x > an.y && an.x > an.z ? 0 : (an.y > an.z ? 1 : 2);
    int cAxis = 3 - axis - nAxis;
    float x = cAxis == 0 ? vLocal.x : cAxis == 1 ? vLocal.y : vLocal.z;
    float rod = nAxis == axis ? 1.0 : sqrt(max(0.0, 1.0 - 4.0 * x * x));
    col *= 0.45 + 0.55 * rod;
    col += vec3(1.0, 0.92, 0.8) * pow(rod, 18.0) * gloss * shade * 0.32 * (1.0 - endFace);

    // Every bar is itself a bundle of hairs: fine threads across its face,
    // each self-lit with its own brightness and its own pulse running along
    // it. Contrast fades out where threads get sub-pixel, so they never shimmer.
    if (uDetail > 0.5 && nAxis != axis) {
      float cross = cAxis == 0 ? vWorld.x : cAxis == 1 ? vWorld.y : vWorld.z;
      float k = cross / 0.055 + seed * 17.0;
      float id = floor(k);
      float h = fract(sin(id * 12.9898 + seed * 78.233) * 43758.5453);
      float hair = pow(1.0 - abs(fract(k) - 0.5) * 2.0, 3.0);
      hair = mix(0.25, hair, 1.0 - smoothstep(0.3, 0.8, fwidth(k)));
      float pulse = pow(max(0.0, sin(dot(vWorld, along) * 0.06 - uTime * (0.25 + h * 0.5) + h * 40.0)), 50.0);
      col *= 0.55 + 0.9 * hair * (0.5 + h);
      col += c * 0.5 * hair * (0.12 + 0.2 * h + 1.6 * pulse) * (0.6 + near);
    }

    // gloss: a specular glint off each bar's side, and a band of light that
    // travels along the fibres
    if (uDetail > 0.5) {
      vec3 H = normalize(L + V);
      float spec = pow(max(dot(N, H), 0.0), 70.0) * gloss;
      float s = dot(vWorld, along);
      float sheen = pow(max(0.0, sin((s * 0.035 - uTime * 0.09 + seed * 5.0) * 6.2832)), 40.0) * gloss;
      col += vec3(1.0, 0.9, 0.74) * (spec * 0.4 + sheen * 0.9) * shade * (1.0 - endFace);
    }

    // a pool of light around the room you occupy; the rest sinks into shade
    float pd = length(vWorld - uFocus);
    col *= 0.2 + 0.95 * exp(-pd * pd / (2.0 * 13.0 * 13.0));

    // soft knee on highlights: glints glow under bloom but never clip into
    // a flat white strip
    float pk = max(col.r, max(col.g, col.b));
    if (pk > 0.7) col *= (0.7 + 0.3 * (1.0 - exp(-(pk - 0.7) / 0.3))) / pk;
    // the way in: a fibre being drawn glows for a short way behind its moving
    // end; heads passing close to the eye stay dark, or a bundle's heads
    // together fill the screen with light. Once built, no fibre takes this.
    if (vTip < 12.0) col += vec3(1.0, 0.8, 0.52) * exp(-vTip / 1.1) * 0.32 * smoothstep(6.0, 16.0, length(cameraPosition - vWorld));

    // distance melts into warm light rather than black
    float depth = length(cameraPosition - vWorld);
    float fog = 1.0 - exp(-pow(uFogDensity * depth, 2.0));
    gl_FragColor = vec4(mix(col, uFog, fog), 1.0);
    #include <colorspace_fragment>
  }
`;

// deterministic PRNG, so a beam's fibres are the same every load
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mod = (n, m) => ((n % m) + m) % m;

// One beam along `axis` whose centre sits at (u, v) in the other two axes and
// which runs lo..hi. Fibres are laid across each of its four faces with random
// widths and relief, cut into segments that repeat every PERIOD cells.
function addBeam(out, axis, u, v, lo, hi, layoutSeed) {
  const [ua, va] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
  // rank: which strands go first when the construct has to draw fewer (the
  // strand levels in site.js): cores, then broad spines, then the hairlines
  const put = (alongC, alongLen, uC, uLen, vC, vLen, seed, shade, gloss, rank) => {
    const c = [0, 0, 0];
    const s = [0, 0, 0];
    c[axis] = alongC; s[axis] = alongLen;
    c[ua] = uC; s[ua] = uLen;
    c[va] = vC; s[va] = vLen;
    out.push(c, s, [seed, shade, axis, gloss], rank);
  };

  // the dark core the fibres are wrapped around
  put((lo + hi) / 2, hi - lo, u, CORE * 2, v, CORE * 2, 0.5, 0.12, 0, 0);

  const repeat = CELL * PERIOD;
  for (let face = 0; face < 4; face += 1) {
    const random = prng(layoutSeed * 131 + face * 7919 + axis * 104729);
    const sign = face & 1 ? 1 : -1;
    const onU = face < 2;          // face normal points along u or along v
    let t = -BEAM / 2;
    while (t < BEAM / 2) {
      // mostly hairlines with the odd broad spine, like the film's shelving
      const width = 0.025 + Math.pow(random(), 2.6) * 0.26;
      const relief = 0.03 + Math.pow(random(), 1.5) * 0.34;
      const seed = random();
      const lit = random() < 0.035;
      const shade = lit ? 1.3 : 0.32 + Math.pow(random(), 1.3) * 0.85;
      const gloss = 0.25 + random() * 0.75;
      // one period's worth of segments, tiled along the beam
      const segments = [];
      let p = 0;
      while (p < repeat) {
        const len = Math.min(repeat - p, 12 + random() * 46);
        const gap = random() < 0.45 ? 0.08 + random() * 0.5 : 0;
        segments.push([p, Math.max(0.2, len - gap), relief * (0.7 + random() * 0.6)]);
        p += len;
      }
      const tC = t + width / 2;
      const w = width * 0.94;
      // the fibre's own seed splits the hairlines, so the layout is unchanged
      const rank = width >= 0.1 ? 1 : seed < 0.5 ? 2 : 3;
      for (let base = Math.floor(lo / repeat) * repeat; base < hi; base += repeat) {
        for (const [start, len, h] of segments) {
          const a0 = Math.max(lo, base + start);
          const a1 = Math.min(hi, base + start + len);
          if (a1 - a0 < 0.1) continue;
          const nC = sign * (CORE - 0.05 + h / 2);
          if (onU) put((a0 + a1) / 2, a1 - a0, u + nC, h + 0.1, v + tC, w, seed, shade, gloss, rank);
          else put((a0 + a1) / 2, a1 - a0, u + tC, w, v + nC, h + 0.1, seed, shade, gloss, rank);
        }
      }
      t += width;
    }
  }
}

export function buildLattice(palette, { span = SPAN, zFar = Z_FAR } = {}) {
  latticeUniforms.uPalette.value = palette;
  const out = [];
  const lines = [];
  for (let i = -span; i <= span + 1; i += 1) lines.push((i - 0.5) * CELL);
  const zLines = [];
  for (let k = -zFar; k <= Z_NEAR + 1; k += 1) zLines.push((k - 0.5) * CELL);
  const xyLo = lines[0] - BEAM;
  const xyHi = lines[lines.length - 1] + BEAM;
  const zLo = zLines[0] - BEAM;
  const zHi = zLines[zLines.length - 1] + BEAM;
  const parity = (value) => mod(Math.round(value / CELL - 0.5), PERIOD);

  // beams along z at every x/y grid crossing: the corridors running away
  for (const x of lines) for (const y of lines) addBeam(out, 2, x, y, zLo, zHi, 1 + parity(x) + parity(y) * 4);
  // beams along x and y at every z plane: the frames of each room
  zLines.forEach((z, k) => {
    for (const y of lines) addBeam(out, 0, y, z, xyLo, xyHi, 20 + parity(y) + k * 8);
    for (const x of lines) addBeam(out, 1, x, z, xyLo, xyHi, 200 + parity(x) + k * 8);
  });

  const count = out.length / 4;
  // strands in rank order (a bucket per rank), so drawing fewer is drawing a prefix
  const buckets = [[], [], [], []];
  for (let i = 0; i < count; i += 1) buckets[out[i * 4 + 3]].push(i);
  const order = buckets.flat();
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const data = new Float32Array(count * 4);
  const material = new THREE.ShaderMaterial({ uniforms: latticeUniforms, vertexShader, fragmentShader });
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  const matrix = new THREE.Matrix4();
  const upTo = [0, 0, 0, 0];
  order.forEach((from, i) => {
    const [c, s, d, rank] = [out[from * 4], out[from * 4 + 1], out[from * 4 + 2], out[from * 4 + 3]];
    matrix.makeScale(s[0], s[1], s[2]).setPosition(c[0], c[1], c[2]);
    mesh.setMatrixAt(i, matrix);
    data.set(d, i * 4);
    upTo[rank] = i + 1;
  });
  for (let r = 1; r < upTo.length; r += 1) upTo[r] = Math.max(upTo[r], upTo[r - 1]);
  // how many instances to draw for each strand level (STRANDS in site.js)
  mesh.userData.strands = { all: count, most: upTo[2], spines: upTo[1] };
  geometry.setAttribute("aData", new THREE.InstancedBufferAttribute(data, 4));
  mesh.frustumCulled = false;
  mesh.userData.baseMaterial = material;
  mesh.userData.clearMaterial = new THREE.ShaderMaterial({ uniforms: latticeUniforms, vertexShader, fragmentShader, defines: { NEAR_CLEAR: "" } });
  return mesh;
}

// ── Light shafts ─────────────────────────────────────────────────────────
// Soft cones of light slanting down through the rooms around you. A cylinder
// seen from outside is brightest where it faces you and fades at its rims,
// which is enough to read as light in haze. Added to the lattice mesh, so they
// tile with it; the pattern repeats every PERIOD cells like the fibres do.

export function buildShafts(lattice) {
  const material = new THREE.ShaderMaterial({
    uniforms: { uTime: latticeUniforms.uTime, uFocus: latticeUniforms.uFocus, uBuild: latticeUniforms.uBuild, uBuildAt: latticeUniforms.uBuildAt },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      varying vec3 vN, vW;
      varying float vY;
      void main() {
        vY = uv.y;
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uFocus;
      uniform float uBuild;
      uniform vec3 uBuildAt;
      varying vec3 vN, vW;
      varying float vY;
      void main() {
        // on the way in, a shaft lights well after the construct around it is
        // drawn: alone in open haze the shafts add up to a wash of light
        float lit = smoothstep(8.0, 30.0, uBuild - length(vW - uBuildAt));
        if (lit <= 0.0) discard;
        float face = abs(dot(normalize(vN), normalize(cameraPosition - vW)));
        float ends = smoothstep(0.0, 0.35, vY) * smoothstep(1.0, 0.6, vY);
        float flicker = 0.75 + 0.25 * sin(vY * 9.0 - uTime * 0.4 + vW.x);
        float a = pow(face, 2.0) * ends * flicker * 0.16;
        // thin a shaft where it crosses the focused room's middle, so the light
        // falls past the subject rather than washing over it; and clear one
        // that lines up behind the subject as seen from the eye (an angle off
        // the line of sight, so rooms behind count too), or it stands as a
        // beam behind the animal. In front of the subject it only thins.
        vec3 toFocus = normalize(vec3(uFocus.xy, 0.0) - cameraPosition);
        float off = acos(clamp(dot(normalize(vW - cameraPosition), toFocus), -1.0, 1.0));
        float clear = min(mix(0.12, 1.0, smoothstep(2.0, 6.5, length(vW.xy - uFocus.xy))),
          mix(step(4.0, vW.z) * 0.12, 1.0, smoothstep(0.1, 0.3, off)));
        a *= clear * lit;
        gl_FragColor = vec4(vec3(1.0, 0.8, 0.52) * a, 1.0);
      }
    `,
  });
  const geometry = new THREE.CylinderGeometry(1.3, 2.1, CELL * 1.5, 24, 1, true);
  const add = (x, y, z) => {
    const shaft = new THREE.Mesh(geometry, material);
    shaft.position.set(x, y, z);
    shaft.rotation.set(0.25, 0, -0.42);
    shaft.frustumCulled = false;
    lattice.add(shaft);
  };
  for (let i = -SPAN; i <= SPAN; i += 1) {
    for (let j = -SPAN; j <= SPAN; j += 1) {
      // one falling past the left of every specimen, in the room you look through
      add(i * CELL - 3.2, j * CELL, CELL * 0.75);
      // and deeper ones in every other side room
      if (mod(i, PERIOD) === 1 && mod(j, PERIOD) === 0) for (const k of [0, -1, -2]) add(i * CELL + 1.5, j * CELL, k * CELL);
    }
  }
}
