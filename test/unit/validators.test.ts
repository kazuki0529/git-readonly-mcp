import { describe, expect, it } from 'vitest';
import { validateRemoteName, validateRepositoryPath, validateRevision } from '../../src/git/validators.js';

describe('Git input validators', () => {
  it('accepts ordinary revisions and paths', () => {
    expect(validateRevision('feature/review')).toBe('feature/review');
    expect(validateRepositoryPath('src/main.ts')).toBe('src/main.ts');
    expect(validateRemoteName('upstream-1')).toBe('upstream-1');
  });

  it.each(['--all', 'main..feature', 'main\0feature'])('rejects unsafe revision %s', (value) => {
    expect(() => validateRevision(value)).toThrow();
  });

  it.each(['/etc/passwd', '../secret', 'src/../../secret', ':(glob)**'])('rejects unsafe path %s', (value) => {
    expect(() => validateRepositoryPath(value)).toThrow();
  });

  it.each(['../origin', 'https://example.com/repo.git', '-origin'])('rejects unsafe remote name %s', (value) => {
    expect(() => validateRemoteName(value)).toThrow();
  });
});