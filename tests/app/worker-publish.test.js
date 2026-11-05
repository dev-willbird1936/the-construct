import { test, assert, startApp, api, uploadClip, workerToken } from "./support.js";

// Minimal zip writer for worker-result tests.
// file: { name, data, method (0 stored | 8 deflated), inflated (claimed
// uncompressed size; lie with a small number for the zip-bomb test) }.
function makeZip(files) {
  const encoder = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, data, method = 0, inflated = data.length } of files) {
    const nameBytes = encoder.encode(name);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(0, 14); // crc (unchecked by the server)
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(inflated, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28);
    central.push({ nameBytes, offset, method, size: inflated });
    chunks.push(header, Buffer.from(nameBytes), data);
    offset += 30 + nameBytes.length + data.length;
  }
  const cdStart = offset;
  for (const entry of central) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(entry.method, 10);
    header.writeUInt32LE(0, 16);
    header.writeUInt32LE(entry.size, 24);
    header.writeUInt16LE(entry.nameBytes.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(entry.offset, 42);
    chunks.push(header, Buffer.from(entry.nameBytes));
    offset += 46 + entry.nameBytes.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(offset - cdStart, 12);
  end.writeUInt32LE(cdStart, 16);
  chunks.push(end);
  return Buffer.concat(chunks);
}

async function claimAs(base, jobId, token = workerToken, workerId = "gpu-0") {
  return api(base, "POST", "/api/worker/claim", { body: { workerId }, token });
}

test("worker queue, lease, one-time download, progress, result, publish", async (t) => {
  const { base } = await startApp(t, { configOverrides: { workerLeaseSec: 60 } });
  const { json: up } = await uploadClip(base, {});

  // empty queue
  const empty = await claimAs(base);
  assert.equal(empty.status, 204);

  // wrong token
  assert.equal((await claimAs(base, null, "wrong")).status, 401);

  const created = await api(base, "POST", "/api/jobs", {
    body: { uploadId: up.uploadId, tier: "advanced", email: "alice@example.test" },
  });
  assert.equal(created.status, 200);
  const jobId = created.json.jobId;

  // The authenticated idle poll above is a heartbeat; liveness stays private.
  const pub = await fetch(`${base}/api/worker/status`);
  assert.equal(pub.status, 401);
  assert.ok(!/online/.test(await pub.text()));
  const me0 = await api(base, "GET", "/api/me");
  assert.equal(me0.json.worker.online, true);

  const claimed = await claimAs(base, jobId);
  assert.equal(claimed.status, 200);
  assert.equal(claimed.json.job.id, jobId);
  assert.ok(claimed.json.downloadUrl.startsWith(`/api/worker/download/${up.uploadId}?token=`));

  // second claim finds nothing (visibility timeout)
  assert.equal((await claimAs(base, null, workerToken, "gpu-1")).status, 204);

  // one-time download
  const url = `${base}${claimed.json.downloadUrl}`;
  assert.equal((await fetch(url)).status, 200);
  assert.equal((await fetch(url)).status, 403);

  // progress is visible on the job
  const prog = await api(base, "POST", `/api/worker/${jobId}/progress`, {
    token: workerToken, body: { stage: "solving", detail: "halfway", progress: 0.5 },
  });
  assert.deepEqual(prog.json, { ok: true });
  const mid = await api(base, "GET", `/api/jobs/${jobId}`);
  assert.equal(mid.json.stage, "solving");
  assert.equal(mid.json.progress, 0.5);
  assert.equal(mid.json.worker.online, true);

  // hostile zip is rejected
  const evil = new FormData();
  evil.append("package", new Blob([makeZip([{ name: "../evil.txt", data: Buffer.from("x") }])]), "evil.zip");
  evil.append("result", JSON.stringify({}));
  const evilRes = await fetch(`${base}/api/worker/${jobId}/result`, {
    method: "POST", headers: { authorization: `Bearer ${workerToken}` }, body: evil,
  });
  assert.equal(evilRes.status, 400);

  // happy-path result
  const good = new FormData();
  good.append("package", new Blob([makeZip([
    { name: "atlas.webp", data: Buffer.from("WEBP") },
    { name: "views/a.webp", data: Buffer.from("WEBP2") },
  ])]), "result.zip");
  good.append("result", JSON.stringify({ title: "Pond world", subject: "moose" }));
  const doneRes = await fetch(`${base}/api/worker/${jobId}/result`, {
    method: "POST", headers: { authorization: `Bearer ${workerToken}` }, body: good,
  });
  assert.equal(doneRes.status, 200);
  const done = await api(base, "GET", `/api/jobs/${jobId}`);
  assert.equal(done.json.status, "done");
  assert.equal(done.json.result.viewer, `stable.html?specimen=${jobId}`); // unsafe/absent worker values fall back to the safe default

  // publish -> pending -> invisible -> approved -> visible -> unpublish
  assert.equal((await api(base, "POST", `/api/jobs/${jobId}/publish`)).json.publish, "pending");
  assert.deepEqual((await api(base, "GET", "/api/gallery")).json.specimens, []);
  const pending = await api(base, "GET", "/api/admin/pending", { role: "owner" });
  assert.equal(pending.json.pending.length, 1);
  assert.equal((await api(base, "POST", `/api/admin/${jobId}/approve`, { role: "owner" })).json.publish, "approved");
  const gallery = await api(base, "GET", "/api/gallery");
  assert.equal(gallery.json.specimens.length, 1);
  assert.equal(gallery.json.specimens[0].id, jobId);
  // Public gallery items carry no owner metadata of any kind.
  assert.deepEqual(
    Object.keys(gallery.json.specimens[0]).sort(),
    ["bytes", "durationSec", "id", "meta", "publishedAt", "subject", "thumb", "tier", "title", "viewer"]
  );
  assert.equal((await api(base, "POST", `/api/jobs/${jobId}/unpublish`)).json.publish, "unpublished");
  assert.deepEqual((await api(base, "GET", "/api/gallery")).json.specimens, []);

  // reject path + report
  await api(base, "POST", `/api/jobs/${jobId}/publish`);
  assert.equal((await api(base, "POST", `/api/admin/${jobId}/reject`, { role: "owner" })).json.publish, "rejected");
  assert.deepEqual((await api(base, "POST", "/api/report", { body: { jobId, reason: "test" } })).json, { ok: true });
});

test("zip bombs are rejected during inflation, not after", async (t) => {
  const zlib = await import("node:zlib");
  const { extractZip } = await import("../../backend/app/worker.js");
  const big = Buffer.alloc(5000, 7);
  const bomb = makeZip([{ name: "big.bin", data: zlib.deflateRawSync(big), method: 8, inflated: 10 }]);
  assert.throws(
    () => extractZip(bomb, "/tmp/nowhere", { maxFiles: 10, maxBytes: 100 }),
    /Unpacked size exceeds the limit/
  );
  // ...while an honest small deflated entry still extracts.
  const ok = makeZip([{ name: "small.txt", data: zlib.deflateRawSync(Buffer.from("hi")), method: 8 }]);
  assert.equal(extractZip(ok, "/tmp/nowhere", { maxFiles: 10, maxBytes: 100 })[0].data.toString(), "hi");
});

test("expired leases return to the queue", async (t) => {
  const { base, db } = await startApp(t, { configOverrides: { workerLeaseSec: 60 } });
  const { json: up } = await uploadClip(base, {});
  const { json: created } = await api(base, "POST", "/api/jobs", { body: { uploadId: up.uploadId, tier: "advanced" } });
  await claimAs(base, created.jobId);
  // force the lease into the past, then claim from another worker
  db.prepare("UPDATE jobs SET lease_expires=? WHERE id=?").run(Date.now() - 1000, created.jobId);
  const reclaimed = await claimAs(base, null, workerToken, "gpu-9");
  assert.equal(reclaimed.status, 200);
  assert.equal(reclaimed.json.job.id, created.jobId);
});

test("worker fail endpoint ends the job with fixed user-safe text; hostile result strings are not stored", async (t) => {
  const { base } = await startApp(t);
  const { json: up } = await uploadClip(base, {});
  const created = await api(base, "POST", "/api/jobs", { body: { uploadId: up.uploadId, tier: "advanced", subject: "fox" } });
  const jobId = created.json.jobId;

  const claimed = await claimAs(base, jobId);
  assert.equal(claimed.status, 200);
  assert.equal(claimed.json.job.subject, "fox"); // the worker needs the chosen subject

  // fail needs the bearer token and a claimed job
  assert.equal((await api(base, "POST", `/api/worker/${jobId}/fail`, { body: { reason: "no_subject" } })).status, 401);
  const bad = await api(base, "POST", "/api/worker/nope/fail", { token: workerToken, body: { reason: "no_subject" } });
  assert.equal(bad.status, 404);

  // arbitrary text from the worker never reaches the user: only reason codes map to fixed sentences
  const failed = await api(base, "POST", `/api/worker/${jobId}/fail`, { token: workerToken, body: { reason: "C:\secret\path.py Traceback" } });
  assert.equal(failed.status, 200);
  const job = await api(base, "GET", `/api/jobs/${jobId}`);
  assert.equal(job.json.status, "failed");
  assert.equal(job.json.error, "The Advanced build failed. Try again later.");
  assert.ok(!/secret|Traceback/.test(JSON.stringify(job.json)));
  // a failed job is final: it is not claimable again
  assert.equal((await claimAs(base, null)).status, 204);
});
