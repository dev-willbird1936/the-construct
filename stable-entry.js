// Keep loading and unsupported-data failures visible instead of leaving a blank canvas.
const loading = document.querySelector('#loading');
const canvas = document.querySelector('#view');
function fail(error) {
  canvas.setAttribute('aria-busy', 'false');
  loading.classList.remove('is-done');
  loading.classList.add('is-error');
  loading.setAttribute('role', 'alert');
  loading.replaceChildren();
  const title = document.createElement('b');
  title.textContent = 'Unable to open this reconstruction';
  const message = document.createElement('p');
  message.textContent = error.message || 'The viewer could not start.';
  const retry = document.createElement('a');
  retry.href = 'stable.html';
  retry.textContent = 'Open the default recording';
  loading.append(title, message, retry);
}
canvas.addEventListener('webglcontextlost', () => fail(new Error('The graphics context was lost. Reload to rebuild the scene.')));
import('./stable.js').then(() => canvas.setAttribute('aria-busy', 'false')).catch(fail);
