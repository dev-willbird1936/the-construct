// One page for every 3.5D / 4D view of the grizzly river crossing. Each view is a page of its
// own; this lists them and shows one at a time, so only one WebGL scene is alive at once.
const VIEWS = [
  {
    id: "solid", tag: "3.5D · THE SOLID", title: "The solid", url: "index.html",
    note: "The crossing as a block: every cut-out stacked along time, in the tesseract. Scroll to move through the clip's own time.",
  },
  {
    id: "lab", tag: "3.5D / 4D · NINE VIEWS", title: "Nine ways to hold time", url: "lab.html",
    note: "Millipede · scroll follows the motion · rotate time into space · space-time block · worldline · colour is time · slit-scan · chronophotograph · echo.",
  },
  {
    id: "spacetime", tag: "4D · THREE VIEWS", title: "Time laid out as space", url: "spacetime.html",
    note: "4D point-cloud trail · 3.5D chrono-extrusion · ray-marched video volume.",
  },
  {
    id: "cloud", tag: "4D · BASIC TIER", title: "Point cloud", url: "cloud.html?job=grizzly",
    note: "Depth Anything 3 lifts 40 frames into one shared world; the bear's trail is left where it walked. This is what the Basic upload tier produces.",
  },
  {
    id: "stable", tag: "3.5D · ADVANCED TIER", title: "Rebuilt scene", url: "stable.html?clip=grizzly",
    note: "The full stack: SAM 3.1 cut-outs, DA3 camera and depth, the river as live footage, and the bear as one depth shell per frame. Bounded orbit, cinematic and through-the-lens views.",
  },
];

const tabs = document.querySelector("#tabs");
const frame = document.querySelector("#frame");
const loading = document.querySelector("#loading");
const open = document.querySelector("#stageOpen");

for (const [i, view] of VIEWS.entries()) {
  const button = document.createElement("button");
  button.type = "button";
  button.role = "tab";
  button.dataset.id = view.id;
  button.innerHTML = `<span class="tag">${String(i + 1).padStart(2, "0")} · ${view.tag}</span><b>${view.title}</b><small>${view.note}</small>`;
  button.addEventListener("click", () => show(view.id));
  tabs.append(button);
}

function show(id) {
  const view = VIEWS.find((v) => v.id === id) ?? VIEWS[0];
  for (const button of tabs.children) button.setAttribute("aria-selected", String(button.dataset.id === view.id));
  document.querySelector("#stageTitle").textContent = view.title;
  document.querySelector("#stageNote").textContent = view.note;
  open.href = view.url;
  loading.hidden = false;
  frame.src = "about:blank"; // free the previous scene's GPU memory before the next one starts
  setTimeout(() => { frame.src = view.url; }, 60);
  history.replaceState(null, "", `#${view.id}`);
}

frame.addEventListener("load", () => { if (frame.src !== "about:blank" && !frame.src.endsWith("/about:blank")) loading.hidden = true; });
document.querySelector("#verdict").textContent = `${VIEWS.length} views · one clip`;
show(location.hash.slice(1));
window.addEventListener("hashchange", () => show(location.hash.slice(1)));
