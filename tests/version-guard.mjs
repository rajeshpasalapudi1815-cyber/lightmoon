// A change to the app (docs/) must come with a new VERSION in docs/js/version.js, or installed copies and the
// service worker keep the old files. Usage: node tests/version-guard.mjs <base commit> <head commit>
import { execFileSync } from 'node:child_process';

const [base, head = 'HEAD'] = process.argv.slice(2);
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

if (!base || /^0+$/.test(base)) {
  console.log('version guard: no base commit to compare with (a new branch); skipped');
  process.exit(0);
}
try {
  git('cat-file', '-e', `${base}^{commit}`);
} catch {
  console.log(`version guard: base ${base} isn't in this checkout; skipped`);
  process.exit(0);
}
const changed = git('diff', '--name-only', base, head).split('\n').filter(Boolean);
const app = changed.filter(file => file.startsWith('docs/'));
const bumped = changed.includes('docs/js/version.js') && /^[-+]export const VERSION/m.test(git('diff', base, head, '--', 'docs/js/version.js'));
if (app.length && !bumped) {
  console.error(`version guard: ${app.length} file(s) under docs/ changed but VERSION in docs/js/version.js did not:\n  ${app.join('\n  ')}`);
  process.exit(1);
}
console.log(app.length ? `version guard: docs/ changed and VERSION was bumped` : 'version guard: nothing under docs/ changed');
