import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

for (const [mode, args] of [
  ['CLI', ['server.js']],
  ['require() da hospedagem', ['--input-type=commonjs', '-e', "require('./server.js')"]],
]) {
  test(`Inicialização ${mode}: servidor responde com frontend e API`, { timeout: 10000 }, async t => {
    const port = await freePort();
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: { ...process.env, NODE_ENV: 'production', PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let output = '';
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Servidor não iniciou: ${output}`)), 5000);
      const fail = error => { clearTimeout(timer); reject(error); };
      child.once('error', fail);
      child.once('exit', code => fail(new Error(`Servidor encerrou (${code}): ${output}`)));
      child.stderr.on('data', data => { output += data; });
      child.stdout.on('data', data => {
        output += data;
        if (output.includes('CORREIO LAN iniciado na porta')) { clearTimeout(timer); resolve(); }
      });
    });
    const base = `http://127.0.0.1:${port}`;
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).data.status, 'ok');
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /CORREIO LAN/);
  });
}
