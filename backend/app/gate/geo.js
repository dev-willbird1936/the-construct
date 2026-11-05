// United Kingdom IP gate: bundled CIDR ranges, binary-searched. No runtime network, no dependencies.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "data");

/** { family: 4 | 6, value: number | bigint } or null. Accepts brackets, ports, zone ids and ::ffff:a.b.c.d. */
export function parseIp(raw) {
  if (typeof raw !== "string") return null;
  let text = raw.trim();
  if (!text || text.length > 64) return null;
  if (text.startsWith("[")) text = text.slice(1, text.indexOf("]") > 0 ? text.indexOf("]") : undefined);
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(text)) text = text.slice(0, text.lastIndexOf(":"));
  text = text.split("%")[0];
  if (net.isIPv4(text)) return { family: 4, value: v4(text) };
  if (!net.isIPv6(text)) return null;
  const value = v6(text);
  // ::ffff:a.b.c.d is an IPv4 client seen through a dual-stack socket
  return value >> 32n === 0xffffn ? { family: 4, value: Number(value & 0xffffffffn) } : { family: 6, value };
}

function v4(text) {
  const [a, b, c, d] = text.split(".").map(Number);
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

function v6(text) {
  let [head, tail] = text.includes("::") ? text.split("::") : [text, null];
  const embedded = (part) => {
    const groups = part ? part.split(":") : [];
    if (groups.length && groups.at(-1).includes(".")) {
      const n = v4(groups.pop());
      groups.push((n >>> 16).toString(16), (n & 0xffff).toString(16));
    }
    return groups;
  };
  const left = embedded(head);
  const right = tail === null ? [] : embedded(tail);
  const zeros = tail === null ? 0 : 8 - left.length - right.length;
  return [...left, ...Array(zeros).fill("0"), ...right].reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g || "0", 16)), 0n);
}

function table(lines, family) {
  const ranges = [];
  for (const line of lines) {
    const [base, bitsText] = line.trim().split("/");
    const parsed = parseIp(base);
    const bits = Number(bitsText);
    if (!parsed || parsed.family !== family || !Number.isInteger(bits)) continue;
    if (family === 4) {
      const size = 2 ** (32 - bits);
      const start = Math.floor(parsed.value / size) * size;
      ranges.push([start, start + size - 1]);
    } else {
      const host = 128n - BigInt(bits);
      const start = (parsed.value >> host) << host;
      ranges.push([start, start + (1n << host) - 1n]);
    }
  }
  ranges.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  const merged = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1] + (family === 4 ? 1 : 1n)) { if (range[1] > last[1]) last[1] = range[1]; } else merged.push(range);
  }
  return merged;
}

function within(ranges, value) {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (value < ranges[mid][0]) hi = mid - 1;
    else if (value > ranges[mid][1]) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Builds an isUk(ip) predicate from CIDR line arrays. Anything unparseable is not UK (fail closed). */
export function createGeo({ v4: v4Lines, v6: v6Lines }) {
  const t4 = table(v4Lines, 4);
  const t6 = table(v6Lines, 6);
  if (t4.length < 100) throw new Error(`UK IPv4 table too small (${t4.length}); refusing to start`);
  return {
    sizes: { v4: t4.length, v6: t6.length },
    isUk(raw) {
      const ip = typeof raw === "object" && raw ? raw : parseIp(raw);
      if (!ip) return false;
      return within(ip.family === 4 ? t4 : t6, ip.value);
    },
  };
}

export function loadBundledGeo(dir = DATA) {
  const read = (name) => fs.readFileSync(path.join(dir, name), "utf8").split(/\r?\n/).filter((l) => l && !l.startsWith("#"));
  return createGeo({ v4: read("gb-v4.txt"), v6: read("gb-v6.txt") });
}

/**
 * The client address as seen by the platform edge. Header values are attacker-controlled unless the edge
 * overwrites them, so which header to believe is configuration, not guesswork:
 *   CLIENT_IP_HEADER   header holding the address the edge observed (default x-real-ip)
 *   TRUSTED_PROXY_HOPS when that header is x-forwarded-for: entries counted from the right (default 1)
 * With no usable header the socket address is used, so a direct hit is judged by its real source.
 */
export function clientIp(req, env = process.env) {
  const name = (env.CLIENT_IP_HEADER || "x-real-ip").toLowerCase();
  const raw = req.headers[name];
  let candidate = Array.isArray(raw) ? raw.at(-1) : raw;
  if (name === "x-forwarded-for" && candidate) {
    const parts = candidate.split(",").map((p) => p.trim()).filter(Boolean);
    const hops = Math.max(1, Number(env.TRUSTED_PROXY_HOPS || 1));
    candidate = parts[parts.length - hops];
  }
  return parseIp(candidate) || parseIp(req.socket?.remoteAddress);
}
