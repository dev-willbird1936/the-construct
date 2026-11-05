import { Box3, Vector3 } from './vendor/three/build/three.module.js';

// Frame the observed trail, without deleting distant scene points or changing the orbit angle.
export function frameCloud(bgPos, trPos, fovY, aspect, fallback = new Vector3(0, 0, -1)) {
  if (!Number.isFinite(fovY) || fovY <= 0 || fovY >= 180 || !Number.isFinite(aspect) || aspect <= 0) {
    throw new Error('Cloud camera parameters are invalid.');
  }
  if (!bgPos || !trPos || bgPos.length % 3 || trPos.length % 3) throw new Error('Cloud position buffers are incomplete.');
  const scene = new Box3(), trail = new Box3(), point = new Vector3();
  for (const positions of [bgPos, trPos]) {
    for (let i = 0; i < positions.length; i += 3) {
      point.set(positions[i], positions[i + 1], positions[i + 2]);
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) continue;
      scene.expandByPoint(point);
      if (positions === trPos) trail.expandByPoint(point);
    }
  }
  const focus = trail.isEmpty() ? scene : trail;
  const target = focus.isEmpty() ? fallback.clone() : focus.getCenter(new Vector3());
  const radius = focus.isEmpty() ? 0.5 : Math.max(focus.getSize(new Vector3()).length() / 2, 0.01);
  const halfFov = Math.min(fovY * Math.PI / 360, Math.atan(Math.tan(fovY * Math.PI / 360) * aspect));
  const distance = Math.max(radius / Math.sin(halfFov) * 1.15, radius + 0.02);
  const position = target.clone().add(new Vector3(0.9, 0.55, 0.8).normalize().multiplyScalar(distance));
  const sceneCentre = scene.isEmpty() ? target : scene.getCenter(new Vector3());
  const sceneRadius = scene.isEmpty() ? radius : scene.getSize(new Vector3()).length() / 2;
  return { target, position, radius, distance, far: Math.max(200, position.distanceTo(sceneCentre) + sceneRadius * 1.1), focus: trail.isEmpty() ? scene.isEmpty() ? 'fallback' : 'scene' : 'trail' };
}
