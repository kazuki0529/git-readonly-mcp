import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const tag = process.argv[2]?.trim();
if (!tag) {
  throw new Error('A release tag is required.');
}

const safeTag = tag.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
if (!safeTag) {
  throw new Error('The release tag cannot be converted to a safe asset name.');
}

const outputDirectory = resolve('release-assets');
const packageName = `git-readonly-mcp-${safeTag}`;
const packageDirectory = join(outputDirectory, packageName);
const archiveName = `${packageName}.zip`;
const archivePath = join(outputDirectory, archiveName);

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(packageDirectory, { recursive: true });
await Promise.all([
  copyFile('dist/git-readonly-mcp.mjs', join(packageDirectory, 'git-readonly-mcp.mjs')),
  copyFile('README.md', join(packageDirectory, 'README.md')),
  copyFile('LICENSE', join(packageDirectory, 'LICENSE')),
]);
await chmod(join(packageDirectory, 'git-readonly-mcp.mjs'), 0o755);

await execFileAsync('zip', ['-q', '-r', archiveName, packageName], { cwd: outputDirectory });
const checksum = createHash('sha256').update(await readFile(archivePath)).digest('hex');
await writeFile(`${archivePath}.sha256`, `${checksum}  ${archiveName}\n`);

process.stderr.write(`Created ${archivePath}\n`);
