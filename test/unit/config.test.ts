import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config.js';

describe('parseConfig', () => {
  it('uses cwd when no workspace folder is provided', () => {
    expect(parseConfig([], '/work/project')).toEqual({
      workspaceFolders: ['/work/project'],
      repositoryRoots: ['/work/project'],
    });
  });

  it('collects repeated workspace folders and repository roots', () => {
    expect(parseConfig([
      '--workspace-folder', 'frontend',
      '--workspace-folder', '/work/backend',
      '--repository-root', 'projects',
    ], '/work')).toEqual({
      workspaceFolders: ['/work/frontend', '/work/backend'],
      repositoryRoots: ['/work/projects'],
    });
  });

  it('rejects unknown arguments', () => {
    expect(() => parseConfig(['--command', 'status'])).toThrow('Unknown argument');
  });
});