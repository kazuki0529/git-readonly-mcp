import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
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