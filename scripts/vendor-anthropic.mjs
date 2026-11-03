// Bundles the official Claude SDK (@anthropic-ai/sdk) into one browser file, docs/js/vendor/anthropic.js, since the
// app is plain files with no build step. Run after updating the SDK: node scripts/vendor-anthropic.mjs
import { build } from 'esbuild';
import fs from 'node:fs';

const { version } = JSON.parse(fs.readFileSync(new URL('../node_modules/@anthropic-ai/sdk/package.json', import.meta.url)));
await build({
  stdin: { contents: "export { default } from '@anthropic-ai/sdk';", resolveDir: new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1') },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'eof',
  banner: { js: `// @anthropic-ai/sdk ${version}, bundled by scripts/vendor-anthropic.mjs` },
  outfile: new URL('../docs/js/vendor/anthropic.js', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'),
});
console.log(`docs/js/vendor/anthropic.js: @anthropic-ai/sdk ${version}`);
