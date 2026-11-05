// Only supported generated-world branches need Spark's newer Three.js.
// Other clips and the explicitly selected original world retain their renderer.
const query = new URLSearchParams(location.search);
const generatedWorld = ['horse', 'walker', 'grizzly', 'wolf1', 'wolf2', 'wolf3'].includes(query.get('clip') || 'walker') && query.get('world') !== 'original';
const importMap = document.createElement('script');
importMap.type = 'importmap';
importMap.textContent = JSON.stringify({ imports: {
  three: generatedWorld ? './vendor/three-0.180.0/three.module.js' : './vendor/three/build/three.module.js',
  'three/addons/': './vendor/three/examples/jsm/',
} });
document.currentScript.after(importMap);
