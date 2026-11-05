import * as THREE from 'three';
import { SparkRenderer, SplatMesh } from './vendor/spark-2.2.0/spark.module.js';

// Generated worlds → recorded subject frames. Approximate presentation alignment,
// not calibrated camera recovery or newly measured geometry. World Labs uses
// +Y down/+Z forward here; turn it upright before applying uniform scale.
export const WORLD_ALIGNMENT = {
  horse: { scale: 0.13, position: [-0.06, 0.0265, -0.3], yaw: 0, contact: [0.11, 0.055, -0.054] },
  walker: { scale: 0.1, position: [0, 0.013, -0.32], yaw: 0, contact: null },
  grizzly: { scale: 0.085, position: [0.035, 0.004, -0.1], yaw: 0, contact: null },
  wolves: { scale: 0.085, position: [0.035, 0.004, -0.1], yaw: Math.PI / 2, contact: null },
};

const worldKey = (clip) => /^wolf[1-3]$/.test(clip) ? "wolves" : clip;

// Which asset this device gets. Shared so the download can start before the scene is built.
export function worldUrl(clip, quality = null) {
  // Reuse existing outputs, never generate here. Keep touch/small screens
  // lighter; explicit detail choices always override the device default.
  const resolution = ['100k', '500k', 'full'].includes(quality) ? quality
    : matchMedia('(max-width: 700px), (pointer: coarse)').matches ? '500k' : 'full';
  return `assets/worldlabs/${worldKey(clip)}/world-${resolution}.spz`;
}

export async function loadWorldLabs(renderer, scene, invalidate, clip, quality = null, preloaded = null) {
  const alignment = WORLD_ALIGNMENT[clip] || WORLD_ALIGNMENT[worldKey(clip)];
  if (!alignment) throw new Error('No generated world is available for this clip.');
  const spark = new SparkRenderer({ renderer, onDirty: invalidate });
  const url = worldUrl(clip, quality);
  // Bytes fetched while the rest of the scene loaded; any failure falls back to a normal load.
  const fileBytes = await preloaded?.catch(() => null);
  const mesh = new SplatMesh(fileBytes ? { fileBytes, fileName: url.split('/').pop() } : { url });
  try {
    await mesh.initialized;
    mesh.rotation.set(Math.PI, alignment.yaw, 0, 'YXZ');
    mesh.scale.setScalar(alignment.scale);
    mesh.position.fromArray(alignment.position);
    scene.add(mesh, spark);
    // Keep native Gaussian blending. The collider proxy cut into the horse;
    // splat depth writing broke Gaussian overlap. Neither won image review.
    // A soft contact cue for the present pose, not a recovered physical shadow.
    const contact = alignment.contact ? new THREE.Mesh(new THREE.PlaneGeometry(...alignment.contact.slice(0, 2)), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
      fragmentShader: 'varying vec2 vUv; void main(){float r=length(vUv*2.0-1.0);float a=pow(max(0.0,1.0-r*r),2.0)*0.24;gl_FragColor=vec4(0.0,0.0,0.0,a);}',
    })) : null;
    if (contact) {
      contact.rotation.x = -Math.PI / 2;
      contact.renderOrder = 8e4;
      scene.add(contact);
    }
    return { mesh, spark, contact, ground: alignment.contact?.[2] };
  } catch (error) {
    scene.remove(mesh, spark);
    mesh.dispose();
    spark.dispose();
    throw error;
  }
}
