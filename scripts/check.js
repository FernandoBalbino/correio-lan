import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(file)); else if (file.endsWith('.js')) result.push(file);
  }
  return result;
}
const sources = ['server.js', ...await files('src'), ...await files('public/js'), ...await files('tests'), ...await files('scripts')];
let failed = false;
for (const source of sources) {
  const result = spawnSync(process.execPath, ['--check', source], { encoding: 'utf8' });
  if (result.status !== 0) { failed = true; process.stderr.write(result.stderr); }
}
console.log(`${sources.length} arquivos JavaScript verificados.`);
if (failed) process.exit(1);
