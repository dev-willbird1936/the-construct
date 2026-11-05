// Worker provenance merge tests: allowlisted tokens only, legacy default
// otherwise (flag off / automatic jobs byte-identical). Run:
// node --test tests/app/ (from the repo root, or the Lane D patchwork tree).
import test from "node:test";
import assert from "node:assert/strict";
import { mergeWorkerProvenance, WORKER_PROVENANCE_ALLOW } from "../../backend/app/worker.js";

test("missing, empty or hostile input falls back to the legacy default", () => {
  const dflt = ["sam-3.1", "muse-image-1.0", "muse-spark-1.3"];
  assert.deepEqual(mergeWorkerProvenance(undefined), dflt);
  assert.deepEqual(mergeWorkerProvenance(null), dflt);
  assert.deepEqual(mergeWorkerProvenance("sam-3.1"), dflt);
  assert.deepEqual(mergeWorkerProvenance([]), dflt);
  assert.deepEqual(mergeWorkerProvenance(["../../../etc/passwd", "muse-spark-1.3;rm -rf"]), dflt);
  assert.deepEqual(mergeWorkerProvenance([42, null, {}]), dflt);
});

test("allowlisted tokens pass through in order, deduped and capped", () => {
  assert.deepEqual(
    mergeWorkerProvenance(["sam-3.1", "birefnet-matte", "depth-anything-v2-small-onnx"]),
    ["sam-3.1", "birefnet-matte", "depth-anything-v2-small-onnx"],
  );
  assert.deepEqual(
    mergeWorkerProvenance(["sam-3.1", "sam-3.1", "evil", "plate-median"]),
    ["sam-3.1", "plate-median"],
  );
  const many = ["sam-3.1", "plate-median", "depth-anything-v2-small-onnx", "muse-image-1.0", "muse-spark-1.3", "birefnet-matte", "sam-3.1", "plate-median", "extra-evil", "muse-image-1.0"];
  assert.ok(mergeWorkerProvenance(many).length <= 8);
  assert.ok(!mergeWorkerProvenance(many).includes("extra-evil"));
});

test("allowlist covers the Basic-pipeline tokens the specimen worker sends", () => {
  for (const t of ["sam-3.1", "depth-anything-v2-small-onnx", "birefnet-matte"]) {
    assert.ok(WORKER_PROVENANCE_ALLOW.has(t), t);
  }
});
