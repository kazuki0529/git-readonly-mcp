import { describe, expect, it, vi } from 'vitest';
import type { GitExecutor } from '../../src/git/queries.js';
import { GitQueries } from '../../src/git/queries.js';

const commitOid = '1111111111111111111111111111111111111111';

describe('GitQueries.log', () => {
  it('follows a single file beyond renames', async () => {
    const run = vi.fn<GitExecutor['run']>().mockResolvedValue({
      stdout: `${commitOid}\n`,
      stderr: '',
      exitCode: 0,
      truncated: false,
    });
    const queries = new GitQueries({ run });

    await queries.log('/repository', {
      revision: 'main',
      path: 'docs/design.md',
      firstParent: false,
      merges: 'include',
      followRenames: true,
      limit: 20,
      offset: 0,
    });

    expect(run).toHaveBeenNthCalledWith(1, '/repository', [
      'rev-parse', '--verify', '--end-of-options', 'main^{commit}',
    ], { signal: undefined });
    expect(run).toHaveBeenNthCalledWith(2, '/repository', [
      'log',
      '--no-color',
      '--no-decorate',
      '--no-show-signature',
      '--no-notes',
      '--no-mailmap',
      '--max-count=20',
      '--skip=0',
      '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%ce%x1f%cI%x1f%s%x1f%b%x1e',
      '--follow',
      commitOid,
      '--',
      'docs/design.md',
    ], { signal: undefined });
  });

  it('requires a path when following renames', async () => {
    const run = vi.fn<GitExecutor['run']>();
    const queries = new GitQueries({ run });

    await expect(queries.log('/repository', {
      firstParent: false,
      merges: 'include',
      followRenames: true,
      limit: 20,
      offset: 0,
    })).rejects.toThrow('path is required');
    expect(run).not.toHaveBeenCalled();
  });
});

describe('GitQueries.showCommit', () => {
  it('limits a patch to one path with explicit context and rename behavior', async () => {
    const run = vi.fn<GitExecutor['run']>().mockResolvedValue({
      stdout: `${commitOid}\n`,
      stderr: '',
      exitCode: 0,
      truncated: false,
    });
    const queries = new GitQueries({ run });

    await queries.showCommit('/repository', {
      revision: 'HEAD',
      includePatch: true,
      contextLine: 8,
      findRenames: false,
      path: 'src/index.ts',
    });

    expect(run).toHaveBeenNthCalledWith(2, '/repository', [
      'show',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--no-show-signature',
      '--no-notes',
      '--no-mailmap',
      '--format=fuller',
      '--stat',
      '--summary',
      '--unified=8',
      '--no-renames',
      '--patch',
      commitOid,
      '--',
      'src/index.ts',
    ], { signal: undefined });
  });
});

describe('GitQueries.diff', () => {
  it('applies the requested patch context and enables rename detection', async () => {
    const run = vi.fn<GitExecutor['run']>().mockResolvedValue({
      stdout: 'patch output',
      stderr: '',
      exitCode: 0,
      truncated: false,
    });
    const queries = new GitQueries({ run });

    await queries.diff('/repository', {
      mode: 'working',
      mergeBase: false,
      format: 'patch',
      contextLine: 8,
      findRenames: true,
    });

    expect(run).toHaveBeenCalledWith('/repository', [
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--ignore-submodules=all',
      '--unified=8',
      '--find-renames',
    ], { signal: undefined });
  });

  it('can disable rename detection', async () => {
    const run = vi.fn<GitExecutor['run']>().mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
      truncated: false,
    });
    const queries = new GitQueries({ run });

    await queries.diff('/repository', {
      mode: 'staged',
      mergeBase: false,
      format: 'name-status',
      contextLine: 3,
      findRenames: false,
    });

    expect(run).toHaveBeenCalledWith('/repository', [
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--ignore-submodules=all',
      '--unified=3',
      '--no-renames',
      '--name-status',
      '-z',
      '--cached',
    ], { signal: undefined });
  });

  it('compares HEAD with staged and unstaged working tree changes', async () => {
    const run = vi.fn<GitExecutor['run']>().mockResolvedValue({
      stdout: `${commitOid}\n`,
      stderr: '',
      exitCode: 0,
      truncated: false,
    });
    const queries = new GitQueries({ run });

    await queries.diff('/repository', {
      mode: 'head',
      mergeBase: false,
      format: 'patch',
      contextLine: 3,
      findRenames: true,
    });

    expect(run).toHaveBeenNthCalledWith(1, '/repository', [
      'rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}',
    ], { signal: undefined });
    expect(run).toHaveBeenNthCalledWith(2, '/repository', [
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--ignore-submodules=all',
      '--unified=3',
      '--find-renames',
      commitOid,
    ], { signal: undefined });
  });
});

describe('GitQueries.readFile', () => {
  it('reads the index entry without resolving a revision', async () => {
    const run = vi.fn<GitExecutor['run']>()
      .mockResolvedValueOnce({ stdout: 'blob\n', stderr: '', exitCode: 0, truncated: false })
      .mockResolvedValueOnce({ stdout: '7\n', stderr: '', exitCode: 0, truncated: false })
      .mockResolvedValueOnce({ stdout: 'indexed', stderr: '', exitCode: 0, truncated: false });
    const queries = new GitQueries({ run });

    const result = await queries.readFile('/repository', {
      target: 'index',
      revision: 'HEAD',
      path: 'docs/design.md',
      maxBytes: 100,
    });

    expect(result.output).toBe('indexed');
    expect(run).toHaveBeenNthCalledWith(1, '/repository', ['cat-file', '-t', ':docs/design.md'], {
      signal: undefined,
    });
    expect(run).toHaveBeenNthCalledWith(2, '/repository', ['cat-file', '-s', ':docs/design.md'], {
      signal: undefined,
    });
    expect(run).toHaveBeenNthCalledWith(3, '/repository', ['cat-file', 'blob', ':docs/design.md'], {
      signal: undefined,
      stdoutLimit: 100,
    });
  });
});
