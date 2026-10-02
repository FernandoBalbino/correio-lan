import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.js';
import { MemoryStore } from '../src/repositories/memory-store.js';
import { RoomService } from '../src/services/room-service.js';
import { normalizeRoom, createEmail } from '../src/utils/validation.js';

test('normaliza sala e cria endereço', () => {
  assert.equal(normalizeRoom('2ANO-INFO'), '2ano-info');
  assert.equal(normalizeRoom(' Turma São Paulo '), 'turma-sao-paulo');
  assert.equal(createEmail('Fernando', '2ANO-INFO'), 'fernando@2ano-info.local');
  assert.throws(() => normalizeRoom('!!!'));
});
test('entrada, unicidade, presença, recuperação e encerramento', () => {
  let clock = 1000;
  const config = createConfig({});
  const store = new MemoryStore({ config, now: () => clock });
  const service = new RoomService(store, config);
  const user = service.join({ name: 'Fernando', username: 'fernando', room: 'TESTE' });
  assert.equal(user.token.length, 43);
  assert.throws(() => service.join({ name: 'Outro', username: 'Fernando', room: 'teste' }), { code: 'USERNAME_ALREADY_EXISTS' });
  service.join({ name: 'Outro', username: 'fernando', room: 'OUTRA' });
  assert.equal(service.users(user).users.length, 1);
  clock += 16000;
  assert.equal(service.users(user).users[0].online, false);
  clock += 45000;
  assert.equal(service.users(user).users.length, 0);
  assert.equal(service.authenticate(user.token).id, user.id);
  assert.throws(() => service.join({ name: 'Outro', username: 'fernando', room: 'TESTE' }), { code: 'USERNAME_ALREADY_EXISTS' });
  service.heartbeat(user);
  assert.equal(service.users(user).onlineCount, 1);
  service.leave(user);
  assert.throws(() => service.authenticate(user.token), { code: 'SESSION_EXPIRED' });
});
test('um professor por sala e identificador reservado', () => {
  const config = createConfig({});
  const service = new RoomService(new MemoryStore({ config }), config);
  assert.throws(() => service.join({ name: 'Aluno', username: 'professor', room: 'TESTE' }), { code: 'RESERVED_USERNAME' });
  const teacher = service.join({ name: 'Docente', role: 'teacher', room: 'TESTE' });
  assert.equal(teacher.email, 'professor@teste.local');
  assert.throws(() => service.join({ name: 'Docente 2', role: 'teacher', room: 'TESTE' }), { code: 'USERNAME_ALREADY_EXISTS' });
});
test('expira sessões e limpa sala vazia', () => {
  let clock = 0;
  const config = createConfig({});
  const store = new MemoryStore({ config, now: () => clock });
  const service = new RoomService(store, config);
  const user = service.join({ name: 'Aluno', username: 'aluno', room: 'TESTE' });
  clock = config.activeTimeout;
  store.cleanup();
  clock += config.roomCleanupTimeout;
  store.cleanup();
  assert.equal(store.rooms.size, 0);
  assert.throws(() => service.authenticate(user.token));
});
