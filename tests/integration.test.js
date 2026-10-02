import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApplication } from '../src/app.js';
import { createConfig } from '../src/config.js';

async function harness(t, options = {}) {
  const application = await createApplication({ config: createConfig(options.env || {}), ...(options.now ? { now: options.now } : {}) });
  const server = application.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await application.close(); });
  const request = async (route, { token, method = 'GET', body, headers = {} } = {}) => {
    const response = await fetch(`${base}/api${route}`, { method, headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...headers,
    }, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) });
    const json = await response.json();
    return { status: response.status, headers: response.headers, ...json };
  };
  const join = async (username, room = 'TESTE', role = 'student') => {
    const result = await request('/rooms/join', { method: 'POST', body: { name: username, username, room, role } });
    assert.equal(result.status, 201); return result.data;
  };
  return { ...application, request, join, base };
}
test('HTTP: frontend, health, sessão, isolamento e CCO em todas as respostas', async t => {
  const { request, join, base } = await harness(t);
  assert.equal((await fetch(base)).status, 200);
  assert.match(await (await fetch(base)).text(), /CORREIO LAN/);
  const health = await request('/health'); assert.equal(health.data.status, 'ok'); assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.equal((await request('/rooms/users')).status, 401);
  const [fernando, maria, joao, pedro, outsider] = await Promise.all([join('fernando'), join('maria'), join('joao'), join('pedro'), join('fora', 'OUTRA')]);
  const result = await request('/messages', { token: fernando.sessionToken, method: 'POST', body: {
    to: [maria.user.email], cc: [joao.user.email], bcc: [pedro.user.email], subject: 'Atividade', body: 'Olá <img src=x onerror=alert(1)>', from: 'outro@teste.local', room: 'OUTRA',
  } });
  assert.equal(result.status, 201); assert.equal(result.data.from, fernando.user.email);
  const id = result.data.id;
  for (const participant of [fernando, maria, joao, pedro]) {
    for (const endpoint of [`/messages/${id}`, '/messages/inbox', '/messages/sent', '/messages/sync?cursor=0']) {
      const response = await request(endpoint, { token: participant.sessionToken });
      assert.equal(response.status, 200); assert.equal(JSON.stringify(response.data).includes(pedro.user.email), false);
      assert.equal(JSON.stringify(response.data).includes('"bcc"'), false);
    }
  }
  assert.equal((await request(`/messages/${id}`, { token: outsider.sessionToken })).status, 404);
  assert.equal((await request('/rooms/users', { token: outsider.sessionToken })).data.users.length, 1);
  await request(`/messages/${id}/trash`, { token: maria.sessionToken, method: 'PATCH' });
  assert.equal((await request('/messages/trash', { token: maria.sessionToken })).data.total, 1);
  await request(`/messages/${id}/restore`, { token: maria.sessionToken, method: 'PATCH' });
  assert.equal((await request('/messages/inbox', { token: maria.sessionToken })).data.total, 1);
  await request(`/messages/${id}/trash`, { token: maria.sessionToken, method: 'PATCH' });
  await request(`/messages/${id}`, { token: maria.sessionToken, method: 'DELETE' });
  assert.equal((await request('/messages/inbox', { token: joao.sessionToken })).data.total, 1);
  assert.equal((await request('/messages', { token: fernando.sessionToken, method: 'POST', body: null })).status, 400);
});
test('HTTP: 30 alunos, atividade, chegada tardia, offline, reconexão e saída', async t => {
  let clock = 1000;
  const { request, join } = await harness(t, { now: () => clock });
  const teacher = await join('Professor', 'TURMA', 'teacher');
  const students = await Promise.all(Array.from({ length: 30 }, (_, index) => join(`aluno${index}`, 'TURMA')));
  const users = await request('/rooms/users', { token: students[0].sessionToken });
  assert.equal(users.data.onlineCount, 31);
  assert.equal((await request('/activities', { token: students[0].sessionToken, method: 'POST', body: { title: 'Teste', instructions: 'X' } })).status, 403);
  await request('/activities', { token: teacher.sessionToken, method: 'POST', body: { title: 'Atividade 01', instructions: 'Informe três periféricos de entrada.' } });
  const late = await join('atrasado', 'TURMA');
  const outsider = await join('outro', 'OUTRA');
  assert.equal((await request('/activities/current', { token: outsider.sessionToken })).data, null);
  const deliveries = await Promise.all(students.map(student => request('/messages', { token: student.sessionToken, method: 'POST', body: {
    to: [teacher.user.email], subject: ' atividade 01 ', body: 'Mouse, teclado e scanner',
  } })));
  assert.ok(deliveries.every(result => result.status === 201));
  let status = (await request('/activities/status', { token: teacher.sessionToken })).data;
  assert.equal(status.delivered, 30); assert.equal(status.pending, 1); assert.equal(status.total, 31);
  clock += 16000;
  assert.equal((await request('/rooms/users', { token: students[0].sessionToken })).data.onlineCount, 0);
  clock += 45000;
  assert.equal((await request('/rooms/users', { token: students[0].sessionToken })).data.users.length, 0);
  assert.equal((await request('/rooms/current', { token: students[0].sessionToken })).data.user.id, students[0].user.id);
  await request('/presence/heartbeat', { token: students[0].sessionToken, method: 'POST' });
  assert.equal((await request('/rooms/users', { token: students[0].sessionToken })).data.onlineCount, 1);
  assert.equal((await request('/messages/sent', { token: students[0].sessionToken })).data.total, 1);
  await request('/rooms/leave', { token: late.sessionToken, method: 'POST' });
  status = (await request('/activities/status', { token: teacher.sessionToken })).data;
  assert.equal(status.total, 31); assert.equal(status.pending, 1);
  assert.equal((await request('/rooms/current', { token: late.sessionToken })).status, 401);
  assert.equal((await request('/messages/inbox', { token: teacher.sessionToken })).data.total, 30);
});
test('HTTP: rate limits por sessão respeitam alunos no mesmo IP', async t => {
  const { request, join } = await harness(t, { env: { MESSAGE_RATE_LIMIT: '2', HEARTBEAT_RATE_LIMIT: '2' } });
  const a = await join('a'); const b = await join('b');
  for (let i = 0; i < 2; i++) assert.equal((await request('/messages', { token: a.sessionToken, method: 'POST', body: { to: [b.user.email], subject: 'Teste' } })).status, 201);
  const blocked = await request('/messages', { token: a.sessionToken, method: 'POST', body: { to: [b.user.email], subject: 'Teste' } });
  assert.equal(blocked.status, 429); assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  assert.equal((await request('/messages', { token: b.sessionToken, method: 'POST', body: { to: [a.user.email], subject: 'Outro aluno' } })).status, 201);
  for (let i = 0; i < 2; i++) assert.equal((await request('/presence/heartbeat', { token: a.sessionToken, method: 'POST' })).status, 200);
  assert.equal((await request('/presence/heartbeat', { token: a.sessionToken, method: 'POST' })).status, 429);
});
test('HTTP: limite de entrada e expiração de sessão não herdam caixas', async t => {
  let clock = 1000;
  const { request, join } = await harness(t, { env: { JOIN_RATE_LIMIT: '2' }, now: () => clock });
  const a = await join('a'); const b = await join('b');
  assert.equal((await request('/rooms/join', { method: 'POST', body: { name: 'C', username: 'c', room: 'TESTE' } })).status, 429);
  const sent = await request('/messages', { token: a.sessionToken, method: 'POST', body: { to: [b.user.email], subject: 'Antiga' } });
  clock += 1800001;
  assert.equal((await request('/rooms/current', { token: b.sessionToken })).status, 401);
  const replacement = await join('b');
  assert.notEqual(replacement.user.id, b.user.id);
  assert.equal((await request('/messages/inbox', { token: replacement.sessionToken })).data.total, 0);
  assert.equal((await request(`/messages/${sent.data.id}`, { token: replacement.sessionToken })).status, 404);
});
test('HTTP: anexos, conteúdo, limite, download privado e encaminhamento autorizado', async t => {
  const { request, join, base } = await harness(t, { env: { MESSAGE_RATE_LIMIT: '30' } });
  const a = await join('a'); const b = await join('b'); const c = await join('c');
  const upload = async (files, extra = {}) => {
    const form = new FormData(); form.set('message', JSON.stringify({ to: [b.user.email], subject: 'Arquivo', body: 'Segue atividade', ...extra }));
    for (const file of files) form.append('attachments', new Blob([file.content], { type: file.type }), file.name);
    return request('/messages', { token: a.sessionToken, method: 'POST', body: form });
  };
  const sent = await upload([{ name: '../../atividade.txt', content: 'Minha atividade é texto.', type: 'text/plain' }]);
  assert.equal(sent.status, 201);
  const file = sent.data.attachments[0]; assert.equal(file.name, 'atividade.txt');
  const url = `${base}/api/messages/${sent.data.id}/attachments/${file.id}`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${c.sessionToken}` } })).status, 404);
  const downloaded = await fetch(url, { headers: { Authorization: `Bearer ${b.sessionToken}` } });
  assert.equal(await downloaded.text(), 'Minha atividade é texto.');
  assert.match(downloaded.headers.get('content-disposition'), /^attachment/);
  assert.equal(downloaded.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await upload([{ name: 'falso.png', content: 'Não é uma imagem', type: 'image/png' }])).status, 400);
  assert.equal((await upload([{ name: 'script.js', content: 'alert(1)', type: 'text/javascript' }])).status, 400);
  assert.equal((await upload([{ name: 'falso.docx', content: 'Não é DOCX', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }])).status, 400);
  assert.equal((await upload([{ name: 'grande.txt', content: 'a'.repeat(2097153), type: 'text/plain' }])).status, 413);
  assert.equal((await upload(Array.from({ length: 4 }, () => ({ name: 'teste.txt', content: 'Texto válido', type: 'text/plain' })))).status, 413);
  const forwarded = await request('/messages', { token: b.sessionToken, method: 'POST', body: {
    to: [c.user.email], subject: 'Enc: Arquivo', body: 'Encaminhado', forwardMessageId: sent.data.id, forwardedAttachmentIds: [file.id],
  } });
  assert.equal(forwarded.status, 201);
  assert.equal((await request('/messages', { token: c.sessionToken, method: 'POST', body: {
    to: [a.user.email], subject: 'Anexo privado', forwardMessageId: sent.data.id, forwardedAttachmentIds: [file.id],
  } })).status, 404);
  const forwardedDownload = await fetch(`${base}/api/messages/${forwarded.data.id}/attachments/${file.id}`, { headers: { Authorization: `Bearer ${c.sessionToken}` } });
  assert.equal(await forwardedDownload.text(), 'Minha atividade é texto.');
});
