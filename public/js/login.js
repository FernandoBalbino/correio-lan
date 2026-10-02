import { api, session } from './api.js';

const form = document.querySelector('#login-form');
const error = document.querySelector('#login-error');
const username = form.elements.username;
function roomSlug(value) { return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, ''); }
function preview() {
  const teacher = form.elements.role.value === 'teacher';
  username.readOnly = teacher;
  if (teacher) username.value = 'professor';
  else if (username.value === 'professor') username.value = '';
  document.querySelector('#email-preview').textContent = `${username.value.trim().toLowerCase() || 'identificador'}@${roomSlug(form.elements.room.value) || 'sala'}.local`;
}
form.addEventListener('input', preview);
form.addEventListener('change', preview);
if (session.get()) {
  api('/rooms/current').then(() => location.replace('/app')).catch(() => {});
}
form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button[type=submit]');
  button.disabled = true; button.textContent = 'Entrando…'; error.hidden = true;
  try {
    const data = await api('/rooms/join', { method: 'POST', body: {
      name: form.elements.name.value, username: username.value, room: form.elements.room.value, role: form.elements.role.value,
    } });
    session.set(data);
    location.assign('/app');
  } catch (failure) { error.textContent = failure.message; error.hidden = false; }
  finally { button.disabled = false; button.textContent = 'Entrar na sala'; }
});
