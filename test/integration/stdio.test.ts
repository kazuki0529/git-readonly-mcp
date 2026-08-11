import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const expectedTools = [
  'git_blame',
  'git_compare_refs',
  'git_diff',
  'git_grep',
  'git_list_refs',
  'git_list_remote_refs',
  'git_list_remotes',
  'git_list_repositories',
  'git_list_tree',
  'git_log',
  'git_range_diff',
  'git_read_file',
  'git_register_repository',
  'git_show_commit',
  'git_status',
];

describe('bundled stdio server', () => {
  let repositoryPath: string;
  let secondRepositoryPath: string;
  let dynamicRoot: string;
  let dynamicRepositoryPath: string;
  let serverDirectory: string;
  let client: Client;

  beforeAll(async () => {
    repositoryPath = await createRepository('git-readonly-mcp-first-');
    secondRepositoryPath = await createRepository('git-readonly-mcp-second-');
    dynamicRoot = await mkdtemp(join(tmpdir(), 'git-readonly-mcp-root-'));
    dynamicRepositoryPath = await createRepositoryAt(dynamicRoot, 'dynamic-');
    serverDirectory = await mkdtemp(join(tmpdir(), 'git-readonly-mcp-bundle-'));
    const standaloneBundle = join(serverDirectory, 'git-readonly-mcp.mjs');
    await copyFile(resolve('dist/git-readonly-mcp.mjs'), standaloneBundle);

    client = new Client({ name: 'git-readonly-mcp-test', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        standaloneBundle,
        '--workspace-folder', repositoryPath,
        '--workspace-folder', secondRepositoryPath,
        '--repository-root', dynamicRoot,
      ],
      cwd: serverDirectory,
      stderr: 'pipe',
    });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client?.close();
    if (repositoryPath) await rm(repositoryPath, { recursive: true, force: true });
    if (secondRepositoryPath) await rm(secondRepositoryPath, { recursive: true, force: true });
    if (dynamicRoot) await rm(dynamicRoot, { recursive: true, force: true });
    if (serverDirectory) await rm(serverDirectory, { recursive: true, force: true });
  });

  it('advertises the complete read-only tool surface', async () => {
    const { tools } = await client.listTools();
    expect(tools.map(({ name }) => name).sort()).toEqual(expectedTools);
    expect(tools.every(({ annotations }) => annotations?.readOnlyHint === true && annotations.destructiveHint === false)).toBe(true);
  });

  it('lists repositories and reads Git data', async () => {
    const repositories = await client.callTool({ name: 'git_list_repositories', arguments: {} });
    expect(repositories.isError).not.toBe(true);
    const structured = repositories.structuredContent as { repositories: Array<{ repositoryId: string; available: boolean }> };
    expect(structured.repositories).toHaveLength(2);
    expect(structured.repositories[0]?.available).toBe(true);
    const repositoryId = structured.repositories[0]?.repositoryId;
    expect(repositoryId).toBeTypeOf('string');

    const log = await client.callTool({ name: 'git_log', arguments: { repositoryId, limit: 10 } });
    expect(log.isError).not.toBe(true);
    expect((log.structuredContent as { output: string }).output).toContain('Initial fixture');

    const file = await client.callTool({ name: 'git_read_file', arguments: { repositoryId, revision: 'HEAD', path: 'README.md' } });
    expect(file.isError).not.toBe(true);
    expect((file.structuredContent as { output: string }).output).toBe('# Fixture\n');
  });

  it('configures diff context and rename detection', async () => {
    const repositories = await client.callTool({ name: 'git_list_repositories', arguments: {} });
    const structured = repositories.structuredContent as { repositories: Array<{ repositoryId: string }> };
    const repositoryId = structured.repositories[1]?.repositoryId;
    expect(repositoryId).toBeTypeOf('string');

    const original = [
      'first',
      'before-8',
      'before-7',
      'before-6',
      'before-5',
      'before-4',
      'before-3',
      'before-2',
      'before-1',
      'original',
      'after-1',
      'after-2',
      'after-3',
      'after-4',
      'after-5',
      'after-6',
      'after-7',
      'after-8',
      'last',
      '',
    ].join('\n');
    await writeFile(join(secondRepositoryPath, 'source.txt'), original);
    await git(secondRepositoryPath, ['add', 'source.txt']);
    await git(secondRepositoryPath, ['commit', '--quiet', '-m', 'Add diff fixture']);
    await writeFile(join(secondRepositoryPath, 'source.txt'), original.replace('original', 'changed'));

    const eightLines = await client.callTool({
      name: 'git_diff',
      arguments: { repositoryId, contextLine: 8, findRenames: false },
    });
    const eightLinesOutput = (eightLines.structuredContent as { output: string }).output;
    expect(eightLines.isError).not.toBe(true);
    expect(eightLinesOutput).toContain('\n before-8\n');
    expect(eightLinesOutput).toContain('-original\n+changed');
    expect(eightLinesOutput).toContain('\n after-8\n');

    await writeFile(join(secondRepositoryPath, 'source.txt'), original);
    await git(secondRepositoryPath, ['mv', 'source.txt', 'renamed.txt']);

    const detected = await client.callTool({
      name: 'git_diff',
      arguments: { repositoryId, mode: 'staged', format: 'name-status', findRenames: true },
    });
    expect(detected.isError).not.toBe(true);
    expect((detected.structuredContent as { output: string }).output).toContain('R100\nsource.txt\nrenamed.txt');

    const disabled = await client.callTool({
      name: 'git_diff',
      arguments: { repositoryId, mode: 'staged', format: 'name-status', findRenames: false },
    });
    const disabledOutput = (disabled.structuredContent as { output: string }).output;
    expect(disabled.isError).not.toBe(true);
    expect(disabledOutput).toContain('D\nsource.txt');
    expect(disabledOutput).toContain('A\nrenamed.txt');
  });

  it('registers a repository under an allowed root at runtime', async () => {
    const registration = await client.callTool({
      name: 'git_register_repository',
      arguments: { path: dynamicRepositoryPath },
    });
    const structured = registration.structuredContent as {
      repository: { repositoryId: string; path: string; available: boolean };
    };

    expect(registration.isError).not.toBe(true);
    expect(structured.repository.path).toBe(dynamicRepositoryPath);
    expect(structured.repository.available).toBe(true);

    const status = await client.callTool({
      name: 'git_status',
      arguments: { repositoryId: structured.repository.repositoryId },
    });
    expect(status.isError).not.toBe(true);
  });

  it('supports history and working tree review workflows', async () => {
    const registration = await client.callTool({
      name: 'git_register_repository',
      arguments: { path: dynamicRepositoryPath },
    });
    const repositoryId = (registration.structuredContent as {
      repository: { repositoryId: string };
    }).repository.repositoryId;
    const designV1 = [
      '# Design',
      'before-8',
      'before-7',
      'before-6',
      'before-5',
      'before-4',
      'before-3',
      'before-2',
      'before-1',
      'decision: proposed',
      'after-1',
      'after-2',
      'after-3',
      'after-4',
      'after-5',
      'after-6',
      'after-7',
      'after-8',
      '',
    ].join('\n');

    await writeFile(join(dynamicRepositoryPath, 'old-design.md'), designV1);
    await git(dynamicRepositoryPath, ['add', 'old-design.md']);
    await git(dynamicRepositoryPath, ['commit', '--quiet', '-m', 'Add initial design']);
    await git(dynamicRepositoryPath, ['mv', 'old-design.md', 'design.md']);
    await git(dynamicRepositoryPath, ['commit', '--quiet', '-m', 'Rename design document']);

    const history = await client.callTool({
      name: 'git_log',
      arguments: { repositoryId, path: 'design.md', followRenames: true, limit: 10 },
    });
    const historyOutput = (history.structuredContent as { output: string }).output;
    expect(history.isError).not.toBe(true);
    expect(historyOutput).toContain('Rename design document');
    expect(historyOutput).toContain('Add initial design');

    const designV2 = designV1.replace('decision: proposed', 'decision: approved');
    await writeFile(join(dynamicRepositoryPath, 'design.md'), designV2);
    await writeFile(join(dynamicRepositoryPath, 'unrelated.md'), 'unrelated change\n');
    await git(dynamicRepositoryPath, ['add', 'design.md', 'unrelated.md']);
    await git(dynamicRepositoryPath, ['commit', '--quiet', '-m', 'Approve design']);
    const reviewCommit = (await git(dynamicRepositoryPath, ['rev-parse', 'HEAD'])).trim();

    const shown = await client.callTool({
      name: 'git_show_commit',
      arguments: {
        repositoryId,
        revision: reviewCommit,
        path: 'design.md',
        contextLine: 8,
        findRenames: true,
      },
    });
    const shownOutput = (shown.structuredContent as { output: string }).output;
    expect(shown.isError).not.toBe(true);
    expect(shownOutput).toContain(' before-8');
    expect(shownOutput).toContain(' after-8');
    expect(shownOutput).not.toContain('unrelated.md');

    await writeFile(join(dynamicRepositoryPath, 'literal*.md'), 'literal original\n');
    await writeFile(join(dynamicRepositoryPath, 'literal-other.md'), 'other original\n');
    await git(dynamicRepositoryPath, ['add', 'literal*.md', 'literal-other.md']);
    await git(dynamicRepositoryPath, ['commit', '--quiet', '-m', 'Add literal path fixtures']);
    await writeFile(join(dynamicRepositoryPath, 'literal*.md'), 'literal changed\n');
    await writeFile(join(dynamicRepositoryPath, 'literal-other.md'), 'other changed\n');

    const literalDiff = await client.callTool({
      name: 'git_diff',
      arguments: { repositoryId, path: 'literal*.md' },
    });
    const literalDiffOutput = (literalDiff.structuredContent as { output: string }).output;
    expect(literalDiff.isError).not.toBe(true);
    expect(literalDiffOutput).toContain('literal*.md');
    expect(literalDiffOutput).not.toContain('literal-other.md');

    const indexedDesign = designV2.replace('decision: approved', 'decision: staged');
    const workingDesign = `${indexedDesign}working-only\n`;
    await writeFile(join(dynamicRepositoryPath, 'design.md'), indexedDesign);
    await git(dynamicRepositoryPath, ['add', 'design.md']);
    await writeFile(join(dynamicRepositoryPath, 'design.md'), workingDesign);

    const headDiff = await client.callTool({
      name: 'git_diff',
      arguments: { repositoryId, mode: 'head', path: 'design.md' },
    });
    const headDiffOutput = (headDiff.structuredContent as { output: string }).output;
    expect(headDiff.isError).not.toBe(true);
    expect(headDiffOutput).toContain('+decision: staged');
    expect(headDiffOutput).toContain('+working-only');

    const revisionFile = await client.callTool({
      name: 'git_read_file',
      arguments: { repositoryId, target: 'revision', revision: 'HEAD', path: 'design.md' },
    });
    expect((revisionFile.structuredContent as { output: string }).output).toBe(designV2);

    const indexFile = await client.callTool({
      name: 'git_read_file',
      arguments: { repositoryId, target: 'index', path: 'design.md' },
    });
    expect((indexFile.structuredContent as { output: string }).output).toBe(indexedDesign);

    const workingFile = await client.callTool({
      name: 'git_read_file',
      arguments: { repositoryId, target: 'working', path: 'design.md' },
    });
    expect((workingFile.structuredContent as { output: string }).output).toBe(workingDesign);

    await writeFile(join(dynamicRepositoryPath, 'draft.md'), 'untracked draft\n');
    const untrackedFile = await client.callTool({
      name: 'git_read_file',
      arguments: { repositoryId, target: 'working', path: 'draft.md' },
    });
    expect((untrackedFile.structuredContent as { output: string }).output).toBe('untracked draft\n');

    const oversized = await client.callTool({
      name: 'git_read_file',
      arguments: { repositoryId, target: 'working', path: 'draft.md', maxBytes: 4 },
    });
    expect(oversized.isError).toBe(true);
    expect(JSON.stringify(oversized.structuredContent)).toContain('limit is 4 bytes');

    const outsideFile = join(serverDirectory, 'outside-design.md');
    await writeFile(outsideFile, 'outside repository\n');
    await symlink(outsideFile, join(dynamicRepositoryPath, 'outside-link.md'));
    const escaped = await client.callTool({
      name: 'git_read_file',
      arguments: { repositoryId, target: 'working', path: 'outside-link.md' },
    });
    expect(escaped.isError).toBe(true);
    expect(JSON.stringify(escaped.structuredContent)).toContain('resolves outside the repository');
  });

  it('rejects runtime registration outside the allowed root', async () => {
    const registration = await client.callTool({
      name: 'git_register_repository',
      arguments: { path: repositoryPath },
    });

    expect(registration.isError).toBe(true);
    expect(JSON.stringify(registration.content)).toContain('outside the configured repository roots');
  });

  it('returns one structured error shape without nested JSON', async () => {
    const result = await client.callTool({
      name: 'git_status',
      arguments: { repositoryId: 'missing-repository' },
    });
    const structured = result.structuredContent as {
      output: string;
      truncated: boolean;
      error: { code: string; message: string };
    };

    expect(result.isError).toBe(true);
    expect(structured).toEqual({
      output: '',
      truncated: false,
      error: {
        code: 'GIT_QUERY_FAILED',
        message: 'Unknown repositoryId: missing-repository',
      },
    });
  });
});

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout;
}

async function createRepository(prefix: string): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), prefix));
  await initializeRepository(repository);
  return repository;
}

async function createRepositoryAt(parent: string, prefix: string): Promise<string> {
  const repository = await mkdtemp(join(parent, prefix));
  await initializeRepository(repository);
  return repository;
}

async function initializeRepository(repository: string): Promise<void> {
  await git(repository, ['init', '--quiet']);
  await git(repository, ['config', 'user.name', 'Test User']);
  await git(repository, ['config', 'user.email', 'test@example.com']);
  await writeFile(join(repository, 'README.md'), '# Fixture\n');
  await git(repository, ['add', 'README.md']);
  await git(repository, ['commit', '--quiet', '-m', 'Initial fixture']);
}