import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { basename, isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { createIsolatedGitEnvironment } from '../git/environment.js';

/** repository初期化時だけ使うPromise形式のGit呼び出し。 */
const execFileAsync = promisify(execFile);

/** 設定済みworkspace folderとrepositoryの利用可否。 */
export interface RepositoryEntry {
  repositoryId: string;
  requestedPath: string;
  path: string | null;
  name: string;
  available: boolean;
  diagnostic: string | null;
}

/** 不透明なrepository IDを検証済みworktreeルートへ解決する。 */
export class RepositoryRegistry {
  /** 検証済みリポジトリと、動的登録を許可する親ディレクトリを保持する。 */
  private constructor(
    private readonly entries: RepositoryEntry[],
    private readonly repositoryRoots: readonly string[],
  ) { }

  /**
  * 明示的に許可したworkspace folderからregistryを構築する。
   *
   * @param workspaceFolders 起動時に登録するworktreeルート。
   * @param repositoryRoots AIからの動的登録を許可する親ディレクトリ。
   */
  static async create(
    workspaceFolders: readonly string[],
    repositoryRoots: readonly string[] = [],
  ): Promise<RepositoryRegistry> {
    const canonicalRoots = await Promise.all(repositoryRoots.map((root) => realpath(root)));
    const registry = new RepositoryRegistry([], [...new Set(canonicalRoots)]);
    const seenPaths = new Set<string>();

    for (const requestedPath of workspaceFolders) {
      try {
        const entry = await inspectRepository(requestedPath);

        // 同じ実体を指すsymlinkや別表記から複数IDが作られるのを防ぐ。
        if (!entry.path || seenPaths.has(entry.path)) {
          continue;
        }
        seenPaths.add(entry.path);
        registry.entries.push(entry);
      } catch (error) {
        const name = basename(requestedPath) || 'repository';
        registry.entries.push({
          repositoryId: `${slug(name)}-${shortHash(requestedPath)}`,
          requestedPath,
          path: null,
          name,
          available: false,
          diagnostic: error instanceof Error ? error.message : 'Repository validation failed.',
        });
      }
    }

    return registry;
  }

  /** 利用不可の診断情報を含む、すべての設定済みfolderを返す。 */
  list(): readonly RepositoryEntry[] {
    return this.entries;
  }

  /**
   * 許可された親ディレクトリ配下のGit worktreeを動的に登録する。
   *
   * @throws 動的登録が無効、許可範囲外、またはworktreeルートでない場合。
   */
  async register(requestedPath: string): Promise<RepositoryEntry> {
    if (this.repositoryRoots.length === 0) {
      throw new Error('Dynamic repository registration is disabled.');
    }

    const canonicalPath = await realpath(resolve(requestedPath));
    if (!this.repositoryRoots.some((root) => containsPath(root, canonicalPath))) {
      throw new Error('Repository path is outside the configured repository roots.');
    }

    const existing = this.entries.find((entry) => entry.path === canonicalPath);
    if (existing) {
      return existing;
    }

    const entry = await inspectRepository(canonicalPath);
    this.entries.push(entry);

    return entry;
  }

  /**
   * 利用可能なrepository IDをcanonical pathへ解決する。
   *
   * @throws IDが未登録、またはworkspace folderが利用不可の場合。
   */
  requirePath(repositoryId: string): string {
    const entry = this.entries.find((candidate) => candidate.repositoryId === repositoryId);
    if (!entry) {
      throw new Error(`Unknown repositoryId: ${repositoryId}`);
    }
    if (!entry.available || !entry.path) {
      throw new Error(`Repository is unavailable: ${repositoryId}`);
    }
    return entry.path;
  }
}

/** 指定パスがGit worktreeのルートそのものであることを検証する。 */
async function inspectRepository(requestedPath: string): Promise<RepositoryEntry> {
  const canonicalPath = await realpath(requestedPath);
  const { stdout: topLevelOutput } = await execFileAsync(
    'git',
    ['--no-optional-locks', '-C', canonicalPath, 'rev-parse', '--show-toplevel'],
    { encoding: 'utf8', timeout: 5_000, env: createIsolatedGitEnvironment() },
  );
  const topLevel = await realpath(topLevelOutput.trim());

  // 親repositoryへ暗黙に昇格すると、許可したパスより広い範囲を読めてしまう。
  if (normalize(topLevel) !== normalize(canonicalPath)) {
    throw new Error('Workspace folder is inside a repository but is not its root.');
  }

  const name = basename(canonicalPath) || 'repository';
  return {
    repositoryId: `${slug(name)}-${shortHash(canonicalPath)}`,
    requestedPath,
    path: canonicalPath,
    name,
    available: true,
    diagnostic: null,
  };
}

/** canonical pathが許可ルート自身またはその子孫かを判定する。 */
function containsPath(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return difference === ''
    || (!isAbsolute(difference) && difference !== '..' && !difference.startsWith(`..${sep}`));
}

/** local path全体を公開せず、短く安定したsuffixを生成する。 */
function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

/** 表示名をportableなrepository ID prefixへ変換する。 */
function slug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return normalized || 'repository';
}