// The only pages served before sign-in. CSS and JS are inline; the few files they use (fonts, the hero loop, its poster
// and three thumbnails) are named one by one in PUBLIC_FILES, and the gate serves exactly those paths pre-auth.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' fill='%2307060a'/%3E%3Cpath d='M8 10h16v12H8z' fill='none' stroke='%23ffd9a8' stroke-width='2'/%3E%3C/svg%3E";

const L = "/assets/landing/";
const FONT_SANS = "/assets/fonts/space-grotesk-var.woff2";
const FONT_MONO = "/assets/fonts/jetbrains-mono-var.woff2";
const POSTER = `${L}poster.jpg`;
// Every path the gate lets through before sign-in (GET/HEAD, exact match). terms.html (with its stylesheet and icon) is
// the public privacy policy that the sign-in page and the OAuth apps link to.
export const PUBLIC_FILES = Object.freeze([
  FONT_SANS, FONT_MONO, POSTER, `${L}hero.webm`, `${L}hero.mp4`,
  `${L}form-ghost.webp`, `${L}form-cloud.webp`, `${L}form-world.webp`,
  "/terms.html", "/styles.css", "/favicon.svg",
]);

const TITLE = "The Construct — a video is a solid";
const ABOUT = "Cut the moving subject out of your clip and walk through its moments as cut-outs, hung in a 3D room.";
// Link-card tags for chat apps and social sites; the image must be an absolute URL.
const meta = (origin = "") => `<meta name="description" content="${esc(ABOUT)}">
<meta property="og:type" content="website"><meta property="og:site_name" content="The Construct">
<meta property="og:title" content="${esc(TITLE)}"><meta property="og:description" content="${esc(ABOUT)}">
<meta property="og:image" content="${esc(origin + POSTER)}"><meta property="og:image:width" content="1120"><meta property="og:image:height" content="630">
<meta property="og:image:alt" content="A black cat's ghost trail hanging in a room of the construct">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(TITLE)}">
<meta name="twitter:description" content="${esc(ABOUT)}"><meta name="twitter:image" content="${esc(origin + POSTER)}">`;

const CSS = `
@font-face{font-family:"Space Grotesk";src:url("${FONT_SANS}") format("woff2-variations"),url("${FONT_SANS}") format("woff2");font-weight:300 700;font-display:swap}
@font-face{font-family:"JetBrains Mono";src:url("${FONT_MONO}") format("woff2-variations"),url("${FONT_MONO}") format("woff2");font-weight:400 700;font-display:swap}
:root{color-scheme:dark;--void:#07060a;--ink:#eef2fa;--muted:#b9b09b;--dim:#8f8672;--line:rgba(238,242,250,.1);--line-strong:rgba(238,242,250,.2);
--glow:#ffd9a8;--glow-soft:rgba(255,217,168,.32);--glass:rgba(8,7,10,.86);--ease:cubic-bezier(.22,1,.36,1);
--display:"Space Grotesk",ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;--mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
*{box-sizing:border-box}html{background:var(--void)}
body{margin:0;min-height:100vh;background:var(--void);color:var(--ink);font:15px/1.5 var(--display);letter-spacing:-.01em;-webkit-font-smoothing:antialiased;overflow-x:hidden}
::selection{background:var(--glow);color:#17120a}[hidden]{display:none!important}
.grain{position:fixed;inset:-6%;z-index:1;pointer-events:none;opacity:.035;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)'/%3E%3C/svg%3E");animation:drift 7s steps(5) infinite}
@keyframes drift{20%{transform:translate(-2%,1%)}40%{transform:translate(1.5%,-1.5%)}60%{transform:translate(-1%,-1%)}80%{transform:translate(1%,1.5%)}}
.kicker{margin:0;font-family:var(--mono);font-size:10.5px;letter-spacing:.34em;text-transform:uppercase;color:var(--glow)}
h1{margin:0;font-weight:500;letter-spacing:-.03em;line-height:1.02}
p{margin:0 0 14px;color:var(--muted)}a{color:var(--glow)}
label{display:block;margin:16px 0 7px;font-family:var(--mono);font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:var(--dim)}
input{width:100%;min-height:48px;padding:12px 14px;border:1px solid var(--line-strong);border-radius:0;background:rgba(5,4,7,.82);color:var(--ink);font:16px/1.3 var(--display);transition:border-color .2s var(--ease)}
input:focus{outline:1px solid var(--glow);outline-offset:2px;border-color:var(--glow)}
input:-webkit-autofill{-webkit-text-fill-color:var(--ink);-webkit-box-shadow:0 0 0 60px #0a090d inset;caret-color:var(--ink)}
button,.btn{display:flex;align-items:center;justify-content:center;width:100%;min-height:48px;margin-top:12px;padding:12px 16px;border:1px solid var(--glow);border-radius:0;background:var(--glow);color:#17120a;font:600 11.5px/1.2 var(--mono);letter-spacing:.16em;text-transform:uppercase;cursor:pointer;text-align:center;text-decoration:none;transition:background .25s var(--ease),color .25s var(--ease),box-shadow .25s var(--ease)}
button:hover,button:focus-visible{box-shadow:0 0 0 4px rgba(255,217,168,.16),0 0 26px rgba(255,217,168,.32);outline:none}
button.quiet,.btn.quiet{background:rgba(8,9,16,.45);color:var(--muted);border-color:var(--line-strong);font-weight:500}
button.quiet:hover,button.quiet:focus-visible,.btn.quiet:hover,.btn.quiet:focus-visible{border-color:var(--glow);color:var(--glow);box-shadow:none;outline:none}
button:disabled{opacity:.55;cursor:wait}
.row{display:grid;gap:8px;margin-top:4px}.row .btn{margin-top:0}
.hint{font-size:13px;line-height:1.45;color:var(--dim);margin:14px 0 0}
.or{display:flex;align-items:center;gap:10px;margin:16px 0 10px;font-family:var(--mono);font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:var(--dim)}.or::before,.or::after{content:"";flex:1;border-top:1px solid var(--line)}
#status{min-height:1.4em;margin-top:8px;font-size:14px;color:var(--glow)}#status:empty{min-height:0;margin-top:0}
details{margin-top:14px;border-top:1px solid var(--line);font-size:13px}
summary{display:flex;align-items:center;min-height:44px;cursor:pointer;font-family:var(--mono);font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:var(--glow)}
details p{margin:6px 0 10px;font-size:13px;line-height:1.5}
.card{position:relative;z-index:2;width:min(440px,calc(100vw - 32px));margin:max(40px,14vh) auto 40px;padding:30px 26px;border:1px solid rgba(255,217,168,.18);background:var(--glass);overflow-wrap:anywhere}
.card h1{font-size:26px;margin:8px 0 10px}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;

const LANDING_CSS = `
body.landing{overflow-y:auto}
.stage{position:fixed;top:-7vh;bottom:7vh;left:30%;right:0;z-index:0;overflow:hidden;
background:url("${POSTER}") 60% 50%/cover no-repeat,radial-gradient(55% 45% at 58% 46%,rgba(255,217,168,.18),transparent 70%),repeating-linear-gradient(90deg,rgba(255,217,168,.06) 0 1px,transparent 1px 9px),repeating-linear-gradient(0deg,rgba(255,217,168,.04) 0 1px,transparent 1px 13px),#0c0a08}
.stage video{display:block;width:100%;height:100%;object-fit:cover;object-position:60% 50%;opacity:0;transition:opacity 1.4s var(--ease)}
.is-live .stage video{opacity:1}
.shade{position:fixed;inset:0;z-index:1;pointer-events:none;background:
linear-gradient(90deg,var(--void) 0,var(--void) 30%,rgba(7,6,10,.82) 36%,rgba(7,6,10,.32) 50%,rgba(7,6,10,0) 64%),
linear-gradient(180deg,rgba(7,6,10,.62),rgba(7,6,10,0) 20%,rgba(7,6,10,0) 60%,rgba(7,6,10,.9) 86%,var(--void) 93%),
radial-gradient(120% 90% at 66% 46%,transparent 45%,rgba(7,6,10,.72) 100%)}
.hud{position:absolute;top:0;left:0;right:0;z-index:3;display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:22px clamp(16px,4.5vw,64px);font-family:var(--mono);text-shadow:0 0 3px #000,0 0 14px rgba(0,0,0,.9)}
.mark{display:flex;align-items:center;gap:11px}
.glyph{position:relative;width:22px;height:22px;border:1px solid var(--glow);opacity:.85}
.glyph::before,.glyph::after{content:"";position:absolute;inset:5px;border:1px solid var(--glow);opacity:.5}
.glyph::after{inset:-5px;opacity:.2;animation:pulse 5s var(--ease) infinite}
@keyframes pulse{50%{transform:scale(1.14);opacity:.05}}
.word{display:grid;gap:2px;font-size:10px;letter-spacing:.18em;color:var(--ink)}
.word em{font-style:normal;font-size:9px;letter-spacing:.1em;color:var(--dim);text-transform:uppercase}
.coord{display:flex;align-items:center;gap:12px;font-size:10px;letter-spacing:.13em;text-transform:uppercase;color:var(--dim)}
.coord b{color:var(--glow);font-weight:500;letter-spacing:.16em}
.coord .live{padding-left:12px;border-left:1px solid var(--line)}.coord .live::before{content:"◈ ";color:var(--glow)}
.page{position:relative;z-index:2;min-height:100vh;display:grid;grid-template-columns:minmax(0,470px) minmax(0,1fr);grid-template-rows:1fr auto;column-gap:clamp(24px,4vw,72px);row-gap:28px;padding:92px clamp(16px,4.5vw,64px) 26px}
.copy{grid-column:1;grid-row:1/3;align-self:center;display:grid;gap:18px}
.copy h1{font-size:clamp(44px,5.3vw,78px);text-wrap:balance;text-shadow:0 2px 28px rgba(0,0,0,.6)}
.lede{margin:0;max-width:29rem;text-wrap:pretty;font-size:clamp(16px,1.3vw,18px);line-height:1.5;color:#ddd3c1}
.panel{position:relative;margin-top:6px;padding:20px 22px 12px;border:1px solid rgba(255,217,168,.16);background:var(--glass)}
.panel::before,.panel::after{content:"";position:absolute;width:12px;height:12px;border:1px solid var(--glow);pointer-events:none}
.panel::before{top:-1px;left:-1px;border-right:0;border-bottom:0}.panel::after{right:-1px;bottom:-1px;border-left:0;border-top:0}
.panel label:first-of-type{margin-top:0}
.panel #f2 p{color:#ddd3c1;font-size:14px}.panel #f2 .hint{margin:0 0 4px;font-size:13px;color:var(--dim)}
.forms{grid-column:2;grid-row:2;align-self:end;justify-self:end;width:min(100%,560px)}
.forms .kicker{margin:0 0 10px;color:#cfc4ae;font-size:9.5px;letter-spacing:.24em;text-shadow:0 0 3px #000,0 0 12px #000,0 0 22px rgba(0,0,0,.9)}
.forms ul{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
.forms li{display:grid;align-content:start;gap:4px;padding:7px 7px 11px;border:1px solid rgba(255,217,168,.16);background:rgba(6,5,8,.82)}
.forms img{display:block;width:100%;height:auto;aspect-ratio:3/2;object-fit:cover;margin-bottom:6px;color:transparent;font-size:0;background:repeating-linear-gradient(90deg,rgba(255,217,168,.07) 0 1px,transparent 1px 7px),#0c0a08;border:1px solid rgba(255,217,168,.1)}
.forms small{font-family:var(--mono);font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:var(--dim)}
.forms b{font-family:var(--mono);font-size:11px;font-weight:500;letter-spacing:.24em;text-transform:uppercase;color:var(--glow)}
.forms span{font-size:12.5px;line-height:1.4;color:var(--muted)}
.credits{grid-column:1/-1;grid-row:3;margin:0;font-size:11.5px;line-height:1.5;color:var(--dim)}
@media (max-width:1080px),(max-height:860px){.forms li span{display:none}}
@media (max-width:1080px){.page{grid-template-columns:minmax(0,440px) minmax(0,1fr)}}
@media (max-width:820px){
.stage{position:absolute;top:0;left:0;right:0;bottom:auto;height:56vh;height:56svh}
.stage video,.stage{background-position:62% 50%}.stage video{object-position:62% 50%}
.shade{position:absolute;bottom:auto;height:calc(56svh + 2px);height:calc(56vh + 2px);background:linear-gradient(180deg,rgba(7,6,10,.6),rgba(7,6,10,0) 22%,rgba(7,6,10,0) 48%,rgba(7,6,10,.86) 80%,var(--void))}
@supports (height:1svh){.shade{height:calc(56svh + 2px)}}
.hud{padding:16px 16px}.coord .room{display:none}
.page{display:block;padding:calc(56svh - 128px) 16px 28px}
@supports not (height:1svh){.page{padding-top:calc(56vh - 128px)}}
.copy{gap:14px}.copy h1{font-size:clamp(38px,11vw,52px)}
.forms{width:auto;margin-top:30px}.forms li span{display:block}
.credits{margin-top:22px}}
@media (max-width:520px){.forms ul{grid-template-columns:1fr;gap:8px}
.forms li{grid-template-columns:112px minmax(0,1fr);grid-template-rows:auto auto 1fr;column-gap:12px;row-gap:2px;padding:7px}
.forms img{grid-row:1/4;margin:0}}
`;

const shell = (title, body, { script = "", landing = false, origin = "" } = {}) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow"><meta name="theme-color" content="#07060a"><meta name="color-scheme" content="dark">
<title>${esc(title)}</title><link rel="icon" href="${FAVICON}">
${landing ? `${meta(origin)}
<link rel="preload" href="${FONT_SANS}" as="font" type="font/woff2" crossorigin><link rel="preload" href="${FONT_MONO}" as="font" type="font/woff2" crossorigin>` : ""}
<style>${CSS}${landing ? LANDING_CSS : ""}</style></head>
<body${landing ? ` class="landing"` : ""}><div class="grain" aria-hidden="true"></div>${landing ? body : `<main class="card">${body}</main>`}${script ? `<script>${script}</script>` : ""}</body></html>`;

// Shared by the email and invite forms; server-side policy remains authoritative.
const POST_HELPER = `
let busy=false;
async function post(url,data){
 if(busy)return null;
 busy=true;
 const controls=[...document.querySelectorAll("input,button")].filter(el=>!el.disabled);
 controls.forEach(el=>el.disabled=true);
 const status=document.getElementById("status");status.textContent="";
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),15000);
 try{
  const r=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data),signal:controller.signal});
  const j=await r.json();return{ok:r.ok,status:r.status,j};
 }catch(error){status.textContent=error.name==="AbortError"?"Request timed out. Check your connection and try again.":"Request failed. Check your connection and try again.";return null}
 finally{clearTimeout(timer);controls.forEach(el=>el.disabled=false);busy=false}
}`;

// The hero loop is a real capture of the construct (the CC0 black-cat room). It starts only when motion is welcome and
// data is not being saved; until it plays (or if it never does) the poster and the CSS backdrop stand in.
const HERO_SCRIPT = `
(()=>{const v=document.getElementById("hero");if(!v)return;
const calm=matchMedia("(prefers-reduced-motion: reduce)").matches||(navigator.connection&&navigator.connection.saveData);
if(calm)return;
v.muted=true;v.defaultMuted=true;v.playsInline=true;
v.innerHTML='<source src="${L}hero.webm" type="video/webm; codecs=vp9"><source src="${L}hero.mp4" type="video/mp4">';
v.addEventListener("playing",()=>document.body.classList.add("is-live"),{once:true});
v.load();const p=v.play();if(p&&p.catch)p.catch(()=>{});})();`;

const FORMS = [
  ["ghost", "01 · Lite", "Ghost trail", "Every pose of one subject as cut-outs, lined up through time.", "A black cat's poses as a trail of cut-outs"],
  ["cloud", "02 · Basic", "Cloud trail", "Its moments as points in estimated depth, over its scene.", "A roe deer grazing, hung over its scene"],
  ["world", "03 · Advanced", "World", "The filmed place in estimated 3D, with the subject at each moment.", "A grey squirrel in its filmed place"],
];

// Social sign-in buttons (auth agent). Brand rules: Google "dark" button (#131314 fill, #8E918F stroke, #E3E3E3 text,
// full-colour G); Facebook blue #1877F2 with the white "f" mark. Shown only for providers configured on the server.
// Landing: the whole block is <div class="social" id="social-signin"> with its own <style>; style around it, not inside it.
const G_LOGO = `<svg class="sso-mark" viewBox="0 0 48 48" width="20" height="20" aria-hidden="true" focusable="false"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`;
const F_LOGO = `<svg class="sso-mark" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path fill="#fff" d="M24 12.07C24 5.41 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.1 10.13 24v-8.44H7.08v-3.49h3.04V9.41c0-3.02 1.8-4.7 4.54-4.7 1.31 0 2.68.24 2.68.24v2.97h-1.5c-1.5 0-1.96.93-1.96 1.89v2.26h3.32l-.53 3.5h-2.8V24C19.62 23.1 24 18.1 24 12.07"/></svg>`;
const SSO_CSS = `<style>
.social{margin-top:4px;display:grid;gap:8px}
.social .sso{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;min-height:48px;padding:0 12px;border-radius:4px;font:500 14px/20px Roboto,"Segoe UI",Helvetica,Arial,sans-serif;letter-spacing:.25px;text-transform:none;text-decoration:none;cursor:pointer}
.social .sso-google{background:#131314;border:1px solid #8E918F;color:#E3E3E3}
.social .sso-google:hover{background:#1f1f21}
.social .sso-facebook{background:#1877F2;border:1px solid #1877F2;color:#fff;font-weight:600}
.social .sso-facebook:hover{background:#166FE5;border-color:#166FE5}
.social .sso:focus-visible{outline:2px solid #ffd9a8;outline-offset:2px}
.social .sso-mark{flex:none;width:20px;height:20px}
</style>`;

export function signinPage({ next, providers, origin = "", ukOnly = false }) {
  const oauth = [
    providers.google ? `<a class="sso sso-google" id="sso-google" href="/auth/google?next=${encodeURIComponent(next)}">${G_LOGO}<span>Continue with Google</span></a>` : "",
    providers.facebook ? `<a class="sso sso-facebook" id="sso-facebook" href="/auth/facebook?next=${encodeURIComponent(next)}">${F_LOGO}<span>Continue with Facebook</span></a>` : "",
  ].join("");
  const email = providers.email ? `
<form id="f1" autocomplete="on" novalidate><label for="email">Email</label>
<input id="email" name="email" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com" required autofocus>
<button type="submit">Email me a sign-in code</button></form>
<form id="f2" hidden novalidate><p>If <b id="sent"></b> is invited, an 8-digit code arrives within a minute. It works once and expires in 15 minutes.</p>
<p class="hint">No email? Check your spam folder. Not invited yet? Ask the owner for access.</p>
<label for="code">Code</label><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="12" required>
<button type="submit">Sign in</button><button class="quiet" type="button" id="back">Use a different email</button></form>` : `<p>Email sign-in is not available right now.</p>`;
  const onTiers = String(process.env.ENABLED_TIERS || "lite,basic,advanced").split(",").map((t) => t.trim());
  const shownForms = FORMS.filter(([key]) => onTiers.includes({ ghost: "lite", cloud: "basic", world: "advanced" }[key]));
  const forms = shownForms.map(([key, tier, name, what, alt]) => `<li><img src="${L}form-${key}.webp" alt="${esc(alt)}" width="480" height="320" loading="lazy" decoding="async" onerror="this.style.visibility='hidden'"><small>${tier}</small><b>${name}</b><span>${what}</span></li>`).join("");
  const body = `<div class="stage" aria-hidden="true"><video id="hero" muted loop playsinline disablepictureinpicture preload="none" tabindex="-1"></video></div>
<div class="shade" aria-hidden="true"></div>
<header class="hud"><div class="mark"><span class="glyph" aria-hidden="true"></span><span class="word">THE CONSTRUCT<em>a video is a solid</em></span></div>
<div class="coord" aria-hidden="true"><span class="room">room <b>+0 , +0</b></span><span class="live">live capture</span></div></header>
<main class="page">
<div class="copy"><p class="kicker">The construct</p><h1>A video is a solid.</h1>
<p class="lede">${esc(ABOUT)}</p>
<section class="panel" aria-label="Sign in"><p class="kicker" style="color:var(--dim);font-size:9.5px;letter-spacing:.24em;margin:0 0 12px">Sign in to walk the examples and build your own</p>${email}
${oauth ? `${SSO_CSS}<div class="or">or</div><div class="social" id="social-signin" aria-label="Other ways to sign in">${oauth}</div>` : ""}
<div id="status" role="status" aria-live="polite"></div>
<p class="hint">${ukOnly ? "UK only. " : ""}Only upload video you have the right to use.</p>
<details><summary>Data use, privacy and help</summary>
<p>Your email and sign-in records are stored to keep your account and builds yours.</p>
<p>If you upload a clip, its frames are sent to Meta&rsquo;s Model API in standard mode &mdash; not used for training. Clips, builds and usage records are stored to provide the service.</p>
<p>Unpublished builds are not shown in the shared gallery. Publishing shows them to other signed-in users only after owner approval. Delete builds from My builds.</p>
<p>For access, correction or deletion requests, use the operator address in your sign-in email. Read the full <a href="/terms.html" target="_blank" rel="noopener">Terms &amp; privacy</a>.</p></details></section></div>
${shownForms.length === 3 ? `<section class="forms" aria-label="Three things it builds"><p class="kicker">Three things it builds from one clip</p><ul>${forms}</ul></section>
<p class="credits">Shown: <i>Black Cat walking</i> by Dzkouslavia, CC0 (the moving clip and first card); <i>European roe deer in Slovakia</i> by The Nature Box, CC BY 3.0; <i>Squirrel eating nut</i> by Anton Porsche, CC BY 4.0; all via Wikimedia Commons. Each was built by this site's own pipeline.</p>` : `<section class="forms" aria-label="What it builds"><p class="kicker">What it builds from one clip</p><ul>${forms}</ul></section>
<p class="credits">Shown: <i>Black Cat walking</i> by Dzkouslavia, CC0, via Wikimedia Commons. Built by this site's own pipeline.</p>`}
</main>`;
  const script = `${POST_HELPER}
const next=${JSON.stringify(next).replaceAll("<", "\\u003c")};const $=(i)=>document.getElementById(i);const st=$("status");
const f1=$("f1"),f2=$("f2");
if(f1){f1.addEventListener("submit",async(e)=>{e.preventDefault();if(busy)return;const email=$("email").value.trim();
 if(!email||!$("email").validity.valid){st.textContent="Enter a valid email address.";$("email").focus();return}
 const r=await post("/auth/start",{email});if(!r)return;
 if(r.status===429){st.textContent="Too many attempts. Try again later.";return}
 if(!r.ok){st.textContent="Could not send a code. Check the address and try again.";return}
 $("sent").textContent=email;$("code").value="";f1.hidden=true;f2.hidden=false;$("code").focus()});
 f2.addEventListener("submit",async(e)=>{e.preventDefault();if(busy)return;const code=$("code").value.replace(/[^0-9]/g,"");
 if(code.length!==8){st.textContent="Enter the 8-digit code from your email.";$("code").focus();return}
 const r=await post("/auth/verify",{email:$("email").value.trim(),code,next});if(!r)return;
 if(r.ok){location.replace(r.j.next||next)}else if(r.status===429){st.textContent="Too many attempts. Try again later."}else{st.textContent="That code did not work. Check it, or request a new one."}});
 $("back").addEventListener("click",()=>{f2.hidden=true;f1.hidden=false;$("code").value="";st.textContent="";$("email").focus()})}
${HERO_SCRIPT}`;
  return shell(`Sign in — ${TITLE}`, body, { script, landing: true, origin });
}

// For link unfurlers (chat apps, social sites): the card's tags and a link, nothing from behind the gate.
export function cardPage({ origin = "" } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(TITLE)}</title><meta name="robots" content="noindex,nofollow">
${meta(origin)}</head><body><h1>${esc(TITLE)}</h1><p>${esc(ABOUT)}</p><p><a href="/signin">Sign in</a></p></body></html>`;
}

export function blockedPage({ canInvite }) {
  const invite = canInvite ? `<form id="g"><label for="c">Invite code</label><input id="c" autocomplete="off"><button type="submit">Continue</button><div id="status" role="status" aria-live="polite"></div></form>` : "";
  const script = canInvite ? `${POST_HELPER}
document.getElementById("g").addEventListener("submit",async(e)=>{e.preventDefault();const r=await post("/geo/code",{code:document.getElementById("c").value});if(!r)return;if(r.ok)location.reload();else document.getElementById("status").textContent=r.status===429?"Too many attempts. Try again later.":"That code did not work."})` : "";
  return shell("Not available — The Construct", `<p class="kicker">The Construct</p><h1>Available in the United Kingdom only</h1><p>This site is currently restricted to visitors in the UK.</p>${invite}`, { script });
}

export function linkPage({ token, next }) {
  return shell("Confirm sign-in — The Construct", `<p class="kicker">The Construct</p><h1>Confirm sign-in</h1><p>Press the button to sign in on this device.</p>
<form method="post" action="/auth/link"><input type="hidden" name="token" value="${esc(token)}"><input type="hidden" name="next" value="${esc(next)}"><button type="submit">Sign in</button></form>`);
}

export function messagePage(title, message) {
  return shell(`${title} — The Construct`, `<p class="kicker">The Construct</p><h1>${esc(title)}</h1><p>${esc(message)}</p><a class="btn quiet" href="/signin">Back to sign in</a>`);
}
