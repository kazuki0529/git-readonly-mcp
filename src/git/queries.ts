import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { GitResult, GitRunOptions } from './runner.js';
import { GitRunner } from './runner.js';
import { validateRemoteName, validateRepositoryPath, validateRevision } from './validators.js';

/** Git toolで共通利用するtext形式のquery結果。 */
export interface QueryOutput {
  output: string;
  truncated: boolean;
  error?: QueryError | undefined;
}

/** Git query失敗時の安定したmachine-readable情報。 */
export interface QueryError {
  code: 'GIT_QUERY_FAILED';
  message: string;
}

/** commit履歴queryが受け付けるfilterとpagination。 */
export interface LogOptions {
  revision?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  path?: string | undefined;
  message?: string | undefined;
  author?: string | undefined;
  since?: string | undefined;
  until?: string | undefined;
  firstParent?: boolean | undefined;
  merges?: 'include' | 'only' | 'exclude' | undefined;
  limit: number;
  offset: number;
}

/** worktreeとrevision比較で受け付けるmode。 */
export interface DiffOptions {
  mode: 'working' | 'staged' | 'revisions';
  base?: string | undefined;
  head?: string | undefined;
  mergeBase: boolean;
  format: 'patch' | 'stat' | 'name-status';
  contextLine: number;
  findRenames: boolean;
  path?: string | undefined;
}

/** repository検索で受け付けるscopeとpattern動作。 */
export interface GrepOptions {
  pattern: string;
  target: 'working' | 'index' | 'revision';
  revision?: string | undefined;
  path?: string | undefined;
  patternType: 'fixed' | 'basic' | 'extended';
  context: number;
}

/** 固定Git queryが必要とする最小限のexecutor契約。 */
export interface GitExecutor {
  /** 指定された制限内で1つの固定Git queryを実行する。 */
  run(repositoryPath: string, args: readonly string[], options?: GitRunOptions): Promise<GitResult>;
}

/** 検証済みdomain parameterから固定の参照専用Git commandを構築する。 */
export class GitQueries {
  /** 注入されたGit実行境界を使ってquery操作を生成する。 */
  constructor(private readonly runner: GitExecutor) { }

  /** indexを更新せずにbranchとworktreeの状態を読む。 */
  async status(repositoryPath: string, signal?: AbortSignal): Promise<QueryOutput> {
    const result = await this.runner.run(repositoryPath, [
      '-c', 'status.showUntrackedFiles=all',
      'status', '--porcelain=v2', '--branch', '--untracked-files=all', '--ignore-submodules=all', '-z',
    ], { signal });
    return textResult(result, result.stdout.split('\0').filter(Boolean).join('\n'));
  }

  /** server側で構築したrevision rangeを使い、上限付きcommit履歴を読む。 */
  async log(repositoryPath: string, options: LogOptions, signal?: AbortSignal): Promise<QueryOutput> {
    const args = [
      'log', '--no-color', '--no-decorate', '--no-show-signature', '--no-notes', '--no-mailmap',
      `--max-count=${options.limit}`, `--skip=${options.offset}`,
      '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%ce%x1f%cI%x1f%s%x1f%b%x1e',
    ];
    if (options.firstParent) args.push('--first-parent');
    if (options.merges === 'only') args.push('--merges');
    if (options.merges === 'exclude') args.push('--no-merges');
    if (options.message) args.push('--fixed-strings', `--grep=${options.message}`);
    if (options.author) args.push(`--author=${options.author}`);
    if (options.since) args.push(`--since=${options.since}`);
    if (options.until) args.push(`--until=${options.until}`);

    args.push(await this.selectRevision(repositoryPath, options, signal));
    if (options.path) args.push('--', validateRepositoryPath(options.path));

    return textResult(await this.runner.run(repositoryPath, args, { signal }));
  }

  /** commit metadataと、必要に応じて上限付きpatchを読む。 */
  async showCommit(repositoryPath: string, revision: string, includePatch: boolean, signal?: AbortSignal): Promise<QueryOutput> {
    const oid = await this.resolveCommit(repositoryPath, revision, signal);
    const args = [
      'show', '--no-color', '--no-ext-diff', '--no-textconv', '--no-show-signature', '--no-notes', '--no-mailmap',
      '--format=fuller', '--stat', '--summary', includePatch ? '--patch' : '--no-patch', oid,
    ];
    return textResult(await this.runner.run(repositoryPath, args, { signal }));
  }

  /** worktree、index、または個別に解決した2つのcommitを比較する。 */
  async diff(
    repositoryPath: string,
    options: DiffOptions,
    signal?: AbortSignal,
  ): Promise<QueryOutput> {
    const args = [
      'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all',
      `--unified=${options.contextLine}`, options.findRenames ? '--find-renames' : '--no-renames',
    ];
    if (options.format === 'stat') args.push('--stat');
    if (options.format === 'name-status') args.push('--name-status', '-z');
    if (options.mode === 'staged') args.push('--cached');
    if (options.mode === 'revisions') {
      if (!options.base || !options.head) throw new Error('base and head are required for revisions mode.');
      const base = await this.resolveCommit(repositoryPath, options.base, signal);
      const head = await this.resolveCommit(repositoryPath, options.head, signal);
      args.push(options.mergeBase ? `${base}...${head}` : base, ...(options.mergeBase ? [] : [head]));
    }

    if (options.path) args.push('--', validateRepositoryPath(options.path));
    const result = await this.runner.run(repositoryPath, args, { signal });

    return textResult(result, options.format === 'name-status' ? result.stdout.replaceAll('\0', '\n') : result.stdout);
  }

  /** 2つのcommit seriesがbaseからheadまでにどう変化したか比較する。 */
  async rangeDiff(repositoryPath: string, oldBase: string, oldHead: string, newBase: string, newHead: string, signal?: AbortSignal): Promise<QueryOutput> {
    const revisions = await Promise.all([oldBase, oldHead, newBase, newHead].map((revision) => this.resolveCommit(repositoryPath, revision, signal)));
    return textResult(await this.runner.run(repositoryPath, [
      'range-diff', '--no-color', '--no-ext-diff', '--no-patch', `${revisions[0]}..${revisions[1]}`, `${revisions[2]}..${revisions[3]}`,
    ], { signal, timeoutMs: 30_000 }));
  }

  /** 検証済みfileと任意の行範囲についてporcelain blame dataを読む。 */
  async blame(repositoryPath: string, revision: string, path: string, start?: number, end?: number, signal?: AbortSignal): Promise<QueryOutput> {
    const oid = await this.resolveCommit(repositoryPath, revision, signal);
    const args = ['blame', '--line-porcelain', '--no-progress'];
    if (start !== undefined || end !== undefined) args.push('-L', `${start ?? 1},${end ?? start ?? 1}`);

    args.push(oid, '--', validateRepositoryPath(path));

    return textResult(await this.runner.run(repositoryPath, args, { signal, timeoutMs: 30_000 }));
  }

  /** 明示的なpattern modeとscopeで追跡対象contentを検索する。 */
  async grep(
    repositoryPath: string,
    options: GrepOptions,
    signal?: AbortSignal,
  ): Promise<QueryOutput> {
    if (options.pattern.includes('\0')) throw new Error('Pattern must not contain NUL.');
    const args = ['grep', '--no-color', '-n', '--column', `--context=${options.context}`];
    if (options.patternType === 'fixed') args.push('--fixed-strings');
    if (options.patternType === 'extended') args.push('--extended-regexp');
    if (options.target === 'index') args.push('--cached');
    if (options.target === 'revision') {
      if (!options.revision) throw new Error('revision is required for revision target.');
      args.push(await this.resolveCommit(repositoryPath, options.revision, signal));
    }

    args.push('-e', options.pattern);
    if (options.path) args.push('--', validateRepositoryPath(options.path));

    // git grepのexit code 1は実行失敗ではなく、該当なしを意味する。
    const result = await this.runner.run(repositoryPath, args, { signal, acceptedExitCodes: [0, 1] });

    return textResult(result);
  }

  /** local参照の一部を上限付きかつ決定的な順序で列挙する。 */
  async listRefs(repositoryPath: string, kind: 'all' | 'heads' | 'tags' | 'remotes', limit: number, signal?: AbortSignal): Promise<QueryOutput> {
    const prefix = kind === 'all' ? 'refs/' : `refs/${kind}/`;
    return textResult(await this.runner.run(repositoryPath, [
      'for-each-ref', `--count=${limit}`, '--sort=-creatordate', '--format=%(objectname)%09%(objecttype)%09%(refname)%09%(creatordate:iso-strict)%09%(subject)', prefix,
    ], { signal }));
  }

  /** fileをcheckoutせず、解決済みcommitのtree entryを列挙する。 */
  async listTree(repositoryPath: string, revision: string, path: string | undefined, recursive: boolean, signal?: AbortSignal): Promise<QueryOutput> {
    const oid = await this.resolveCommit(repositoryPath, revision, signal);
    const args = ['ls-tree', '-z', '--long'];
    if (recursive) args.push('-r');

    args.push(oid);
    if (path) args.push('--', validateRepositoryPath(path));

    const result = await this.runner.run(repositoryPath, args, { signal });

    return textResult(result, result.stdout.replaceAll('\0', '\n'));
  }

  /** typeとsizeを確認してからfile blobを読む。 */
  async readFile(repositoryPath: string, revision: string, path: string, maxBytes: number, signal?: AbortSignal): Promise<QueryOutput> {
    const oid = await this.resolveCommit(repositoryPath, revision, signal);
    const repositoryPathname = validateRepositoryPath(path);
    const spec = `${oid}:${repositoryPathname}`;
    const type = await this.runner.run(repositoryPath, ['cat-file', '-t', spec], { signal });
    if (type.stdout.trim() !== 'blob') throw new Error('Requested object is not a file.');

    // 上限超過blobをmemoryへ載せないため、contentより先にsizeを確認する。
    const size = await this.runner.run(repositoryPath, ['cat-file', '-s', spec], { signal });
    const byteLength = Number.parseInt(size.stdout.trim(), 10);
    if (!Number.isSafeInteger(byteLength) || byteLength > maxBytes) {
      throw new Error(`File is ${byteLength} bytes; limit is ${maxBytes} bytes.`);
    }

    return textResult(await this.runner.run(repositoryPath, ['cat-file', 'blob', spec], { signal, stdoutLimit: maxBytes }));
  }

  /** 2つのrefを解決し、merge baseと左右固有の件数を返す。 */
  async compareRefs(repositoryPath: string, left: string, right: string, signal?: AbortSignal): Promise<QueryOutput> {
    const [leftOid, rightOid] = await Promise.all([this.resolveCommit(repositoryPath, left, signal), this.resolveCommit(repositoryPath, right, signal)]);
    const mergeBase = await this.runner.run(repositoryPath, ['merge-base', leftOid, rightOid], { signal, acceptedExitCodes: [0, 1] });
    const counts = await this.runner.run(repositoryPath, ['rev-list', '--left-right', '--count', `${leftOid}...${rightOid}`], { signal });
    return { output: JSON.stringify({ left: leftOid, right: rightOid, mergeBase: mergeBase.stdout.trim() || null, counts: counts.stdout.trim() }), truncated: false };
  }

  /** 設定URLを公開せずremote名を列挙する。 */
  async listRemotes(repositoryPath: string, signal?: AbortSignal): Promise<QueryOutput> {
    const result = await this.runner.run(repositoryPath, ['remote'], { signal });
    return textResult(result);
  }

  /** 設定済みの匿名public HTTPS remoteからrefを取得する。 */
  async listRemoteRefs(repositoryPath: string, remote: string, limit: number, signal?: AbortSignal): Promise<QueryOutput> {
    const remoteName = validateRemoteName(remote);
    const configuredUrl = await this.runner.run(repositoryPath, ['config', '--get', `remote.${remoteName}.url`], { signal });
    const url = await validatePublicHttpsUrl(configuredUrl.stdout.trim());

    // Gitへendpointを渡す前にURLを検証し、protocolとproxyの制限によって
    // 別transportへのfallbackを防ぐ。
    const result = await this.runner.run(repositoryPath, ['ls-remote', '--refs', url], {
      signal,
      timeoutMs: 10_000,
      environment: { GIT_ALLOW_PROTOCOL: 'https', HTTPS_PROXY: '', HTTP_PROXY: '', ALL_PROXY: '', NO_PROXY: '*' },
    });
    return textResult(result, result.stdout.split('\n').slice(0, limit).join('\n'));
  }

  /** ユーザー向けrevisionを不変のcommit object IDへ解決する。 */
  private async resolveCommit(repositoryPath: string, revision: string, signal?: AbortSignal): Promise<string> {
    const validated = validateRevision(revision);
    const result = await this.runner.run(repositoryPath, ['rev-parse', '--verify', '--end-of-options', `${validated}^{commit}`], { signal });
    return result.stdout.trim();
  }

  /** 単一commit、または解決済みobject IDから組み立てたrangeを選択する。 */
  private async selectRevision(repositoryPath: string, options: LogOptions, signal?: AbortSignal): Promise<string> {
    if (options.from || options.to) {
      if (!options.from || !options.to) throw new Error('from and to must be provided together.');
      const [from, to] = await Promise.all([this.resolveCommit(repositoryPath, options.from, signal), this.resolveCommit(repositoryPath, options.to, signal)]);
      return `${from}..${to}`;
    }
    return await this.resolveCommit(repositoryPath, options.revision ?? 'HEAD', signal);
  }
}

/** MCP登録層が利用するpublic query契約。 */
export type GitQueryService = Pick<GitQueries, keyof GitQueries>;

/** subprocess実装を使うproduction query serviceを生成する。 */
export function createGitQueries(): GitQueries {
  return new GitQueries(new GitRunner());
}

/** process出力を安定したMCP query結果へ変換する。 */
function textResult(result: GitResult, output = result.stdout): QueryOutput {
  return { output, truncated: result.truncated };
}

/** 設定URLが匿名HTTPSであり、public IPへ解決されることを検証する。 */
async function validatePublicHttpsUrl(value: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Remote URL is invalid.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Remote must use anonymous HTTPS without query or fragment.');
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.local')) throw new Error('Local remote hosts are not allowed.');

  // public/privateが混在した応答を許すとinternal endpointへ誘導されるため、
  // 現在のDNS応答がすべてpublicであることを要求する。
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error('Remote hostname must resolve only to public IP addresses.');
  }
  return url.href;
}

/** IPv4またはIPv6 addressがglobalにrouting可能か返す。 */
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [first = 0, second = 0] = address.split('.').map(Number);
    return !(first === 0 || first === 10 || first === 127 || first >= 224 || (first === 100 && second >= 64 && second <= 127) || (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168) || (first === 198 && (second === 18 || second === 19)));
  }

  const normalized = address.toLowerCase();
  if (normalized.startsWith('::ffff:')) {
    // IPv4-mapped IPv6は、埋め込まれたIPv4の分類を引き継ぐ必要がある。
    return isPublicAddress(normalized.slice('::ffff:'.length));
  }

  return isIP(address) === 6
    && normalized !== '::'
    && normalized !== '::1'
    && !normalized.startsWith('fc')
    && !normalized.startsWith('fd')
    && !normalized.startsWith('fe8')
    && !normalized.startsWith('fe9')
    && !normalized.startsWith('fea')
    && !normalized.startsWith('feb')
    && !normalized.startsWith('2001:db8:');
}