import { chmod, rm } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { build } from 'esbuild';

const outfile = 'dist/git-readonly-mcp.mjs';
await rm('dist', { recursive: true, force: true });

const result = await build({
  entryPoints: ['src/index.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  splitting: false,
  sourcemap: false,
  minify: false,
  legalComments: 'eof',
  banner: { js: '#!/usr/bin/env node' },
  metafile: true,
});

const allowedExternal = new Set([
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
]);
const externalImports = Object.values(result.metafile.outputs)
  .flatMap((output) => output.imports)
  .filter((entry) => entry.external && !allowedExternal.has(entry.path));

if (externalImports.length > 0) {
  throw new Error(`Unexpected external imports: ${externalImports.map(({ path }) => path).join(', ')}`);
}
if (Object.keys(result.metafile.outputs).length !== 1) {
  throw new Error('The build must produce exactly one file.');
}

await chmod(outfile, 0o755);