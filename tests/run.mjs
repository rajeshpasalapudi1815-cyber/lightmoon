// Runs every tests/*.test.mjs in its own process (each sets up its own pretend browser) and sums up.
// Run: npm test
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here).filter(name => name.endsWith('.test.mjs')).sort();
let failed = 0;
for (const file of files) {
  const run = spawnSync(process.execPath, [path.join(here, file)], { encoding: 'utf8' });
  const lines = `${run.stdout}${run.stderr}`.split('\n');
  const ok = lines.filter(line => line.startsWith('ok')).length;
  const bad = lines.filter(line => line.startsWith('FAIL')).length;
  const passed = run.status === 0 && !bad;
  if (!passed) failed++;
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${file}: ${ok} ok${bad ? `, ${bad} failed` : ''}${run.status ? ` (exit ${run.status})` : ''}`);
  if (!passed) console.log(lines.filter(line => line.startsWith('FAIL') || /Error|at /.test(line)).slice(0, 20).map(line => `      ${line}`).join('\n'));
}
console.log(failed ? `${failed} of ${files.length} test files failed` : `all ${files.length} test files passed`);
process.exit(failed ? 1 : 0);
