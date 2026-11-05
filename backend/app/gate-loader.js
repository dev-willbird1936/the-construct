// Pass-through for the main session's gate. The real gate lives at
// backend/app/gate/index.js (main session writes it) and exports
// installGate(app, { dataDir }); it is the first middleware, sets
// req.user = { id, email, role } and answers unauthenticated requests itself.
//
// Until it exists, non-production boots fall back to the fake gate in
// test-support/fake-gate.js (tests and local dev only). Production refuses
// to start without the real gate. No auth bypass flags exist anywhere.

export async function loadGateInstaller() {
  try {
    const real = await import("./gate/index.js");
    if (typeof real.installGate !== "function") throw new Error("gate/index.js has no installGate export");
    return { installGate: real.installGate, fake: false };
  } catch (error) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(`refusing to start without the real gate: ${error.message}`);
    }
    const fake = await import("./test-support/fake-gate.js");
    return { installGate: fake.installGate, fake: true };
  }
}
