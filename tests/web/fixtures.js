// Fixtures for spend-free studio UI tests (mirrors backend/app test fakes).
// indexMapPngBase64 is a real 12x12 PNG: 4x4 block id 1, 3x3 block id 2, else 0.
const IDX_MAP_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAwAAAAMCAYAAABWdVznAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAMklEQVQokWNgYGD4TyJmwKuAGQmjaGBEw/TTwIDLDyRrYKBGKDEhYRQNLEiYvhqo4mkAVx2P0sewSmUAAAAASUVORK5CYII=";

const ME_USER = {
  id: "u1",
  email: "builder@example.test",
  role: "user",
  spendTodayCents: 4.2,
  worker: { online: true, lastSeenAt: Date.now() },
};

const ME_OWNER = { ...ME_USER, email: "web.owner@example.test", role: "owner" };

const UPLOAD = {
  uploadId: "up-1",
  jobId: "up-1",
  width: 640,
  height: 360,
  fps: 30,
  frameCount: 90,
  duration: 3,
};

const ROUTE_OK = {
  category: "wildlife",
  camera: "fixed",
  subjects: ["cougar", "grass"],
  warnings: ["subject under 10% of frame at the start"],
};

const ROUTE_DECLINE = {
  category: "other",
  camera: "unknown",
  subjects: [],
  warnings: [],
  decline: "Edited clips with cuts cannot be tracked.",
};

const DETECT = {
  frameIndex: 30,
  frameWidth: 12,
  frameHeight: 12,
  objects: [
    { id: 1, label: "cougar", box: { left: 0.1, top: 0.1, right: 0.5, bottom: 0.5 } },
    { id: 2, label: "bush", box: { left: 0.5, top: 0.5, right: 0.9, bottom: 0.9 } },
    { id: 3, label: "rock", box: { left: 0, top: 0.7, right: 0.2, bottom: 0.9 } },
    { id: 4, label: "bird", box: { left: 0.8, top: 0, right: 1, bottom: 0.2 } },
  ],
  indexMapPngBase64: IDX_MAP_PNG_BASE64,
};

const JOB_RUNNING = {
  id: "job-1",
  tier: "lite",
  status: "running",
  stage: "tracking",
  detail: "Following object 1 of 2…",
  progress: 0.4,
  uploadId: "up-1",
  publish: "unpublished",
  title: "cougar lite",
  subject: "cougar",
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

const JOB_DONE = {
  ...JOB_RUNNING,
  status: "done",
  stage: "done",
  detail: "Ready.",
  progress: 1,
  publish: "unpublished",
  result: {
    id: "job-1",
    tier: "lite",
    title: "cougar solid",
    subject: "cougar",
    viewer: "view-lite.html?id=job-1",
    thumb: "specimens/job-1/thumb.webp",
    durationSec: 3,
    bytes: 600000,
    meta: { camera: "fixed", category: "wildlife", provenance: ["sam-3.1", "muse-spark-1.3"] },
  },
};

const BUILDS = [JOB_DONE];

const GALLERY = {
  specimens: [
    {
      id: "job-1",
      tier: "lite",
      title: "cougar solid",
      subject: "cougar",
      viewer: "view-lite.html?id=job-1",
      thumb: "specimens/job-1/thumb.webp",
      durationSec: 3,
      bytes: 600000,
      meta: { camera: "fixed", category: "wildlife", provenance: ["sam-3.1", "muse-spark-1.3"] },
      publishedAt: Date.now(),
    },
  ],
};

const PENDING = [{ ...JOB_DONE, publish: "pending" }];

module.exports = { IDX_MAP_PNG_BASE64, ME_USER, ME_OWNER, UPLOAD, ROUTE_OK, ROUTE_DECLINE, DETECT, JOB_RUNNING, JOB_DONE, BUILDS, GALLERY, PENDING };
