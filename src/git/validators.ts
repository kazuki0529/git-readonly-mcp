import { isAbsolute, posix, sep } from 'node:path';

/**
 * MCP requestから受け取った単一revision tokenを検証する。
 *
 * rangeは個別に解決したcommit IDからquery method側で構築するため、
 * 入力値としては拒否する。
 */
export function validateRevision(revision: string): string {
  if (!revision || revision.startsWith('-') || hasControlCharacter(revision)) {
    throw new Error('Invalid revision.');
  }
  if (revision.includes('..') || revision.includes('...')) {
    throw new Error('Revision ranges must be expressed with separate parameters.');
  }
  return revision;
}

/** repository内に収まるliteral pathを検証し、正規化する。 */
export function validateRepositoryPath(path: string): string {
  if (!path || isAbsolute(path) || hasControlCharacter(path)) {
    throw new Error('Path must be a non-empty repository-relative path.');
  }
  const portablePath = sep === '/' ? path : path.replaceAll(sep, '/');
  if (portablePath.startsWith(':') || portablePath.split('/').includes('..')) {
    throw new Error('Path traversal and pathspec magic are not allowed.');
  }
  const normalized = posix.normalize(portablePath);
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error('Path must stay inside the repository.');
  }
  return normalized.replace(/^\.\//, '');
}

/** 任意URLではなく、設定済みremote名として妥当か検証する。 */
export function validateRemoteName(remote: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote)) {
    throw new Error('Invalid remote name.');
  }
  return remote;
}

/** Git引数や出力frameを壊す可能性がある制御文字を検出する。 */
function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}