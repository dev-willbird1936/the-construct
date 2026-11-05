import { createApp } from "./app.js";

// Production entrypoint. Railway runs: node backend/app/index.js
// Binds 0.0.0.0:$PORT, persists under $DATA_DIR, recovers interrupted jobs,
// shuts down cleanly on SIGTERM/SIGINT. Refuses to boot in production
// without the real gate (see gate-loader.js) or without a worker token.

const handle = await createApp();
const { app, db, config, recovery } = handle;

if (config.nodeEnv === "production" && !config.workerToken) {
  console.error("WORKER_TOKEN is required in production.");
  process.exit(1);
}
if (config.nodeEnv === "production" && !process.env.META_API_KEY && !process.env.META_BASE_URL) {
  console.error("META_API_KEY or META_BASE_URL is required in production.");
  process.exit(1);
}
if (config.nodeEnv === "production" && handle.gateFake) {
  console.error("Refusing to start production with the fake gate.");
  process.exit(1);
}

const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(`construct app on 0.0.0.0:${config.port} (data ${config.dataDir})`);
  if (recovery.failed || recovery.requeued) {
    console.log(`recovery: ${recovery.failed} failed, ${recovery.requeued} re-queued`);
  }
  if (handle.gateFake) console.warn("gate: FAKE gate active (non-production only)");
  // Presence only, never values.
  console.log(`env: META_BASE_URL=${process.env.META_BASE_URL ? "set" : "unset"} MAIL_MODE=${process.env.MAIL_MODE || "console"} WORKER_TOKEN=${config.workerToken ? "set" : "unset"}`);
});

let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal}: draining…`);
    // Stop queue work first (no new pumps, kill the owned Basic child),
    // then drain connections; the DB closes last so in-flight jobs can
    // still record their outcome.
    handle.stop();
    server.close(() => {
      try {
        db.close();
      } catch { /* ignore */ }
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
