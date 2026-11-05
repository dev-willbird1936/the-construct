// Default to full versus one-in-five; explicit comparisons can select up to three rates.
export function parseFrameStrides(value) {
  if (value === null || value === undefined) return [1, 5];
  const parts = String(value).split(",");
  const strides = parts.map(Number);
  if (parts.some(p => !/^\d+$/.test(p)) || strides.length > 3 || new Set(strides).size !== strides.length || strides.some(n => n < 1 || n > 10)) throw new Error("Choose one to three distinct strides from 1 to 10, for example ?strides=1,5.");
  return strides;
}

// Retain actual source-sample poses. Never renumber, interpolate or force an extra end pose.
export function retainGhosts(ghosts, every) {
  if (!Number.isInteger(every) || every < 1 || every > 10) throw new Error("Choose an integer retention step from 1 to 10.");
  if (ghosts.some(g => !Number.isInteger(g.sample) || g.sample < 0)) throw new Error("Every ghost needs its original nonnegative sample index.");
  return ghosts.filter(g => g.sample % every === 0);
}
