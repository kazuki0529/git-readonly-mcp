import { describe, expect, it, vi } from 'vitest';
import type { GitExecutor } from '../../src/git/queries.js';
import { GitQueries } from '../../src/git/queries.js';

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
});
