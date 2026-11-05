// Source image/cloud RGB bytes are sRGB; Three.js vertex colours use Linear-sRGB.
const linear = Float32Array.from({ length: 256 }, (_, byte) => {
  const value = byte / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
});

export function cloudColors(rgb) {
  if (!(rgb instanceof Uint8Array) || rgb.length % 3) {
    throw new Error("Cloud colours must be complete RGB bytes.");
  }
  const colors = new Float32Array(rgb.length);
  for (let i = 0; i < rgb.length; i++) colors[i] = linear[rgb[i]];
  return colors;
}
