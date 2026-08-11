import { spawn } from 'node:child_process';
import { createIsolatedGitEnvironment } from './environment.js';

/** より厳しい制限がなければ、1 queryで保持するstdoutの最大値。 */
const DEFAULT_STDOUT_LIMIT = 1024 * 1024;

/** 1つのGit processから診断用に保持するstderrの最大値。 */
const DEFAULT_STDERR_LIMIT = 64 * 1024;

/** 固定Git queryへ適用する任意の実行制限。 */
export interface GitRunOptions {
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  stdoutLimit?: number | undefined;
  environment?: NodeJS.ProcessEnv | undefined;
  acceptedExitCodes?: readonly number[] | undefined;
}

/** 完了したGit processから取得した出力。 */
export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
}

/** 許可されていないGit processのexit codeを表す。 */
export class GitCommandError extends Error {
  /** 診断用の上限付きstderrを保持したerrorを生成する。 */
  constructor(
    message: string,
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitCommandError';
  }
}

/** shellを介さず、制限付きGit subprocessを実行する。 */
export class GitRunner {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  /**
   * 許可済みrepository内で、構築済みGit引数を実行する。
   *
   * 呼び出し元は固定Git subcommandを選択し、この境界へ渡す前に
   * 動的引数を検証する責務を持つ。
   */
  async run(repositoryPath: string, args: readonly string[], options: GitRunOptions = {}): Promise<GitResult> {
    const release = await this.acquire();
    try {
      return await this.runProcess(repositoryPath, args, options);
    } finally {
      release();
    }
  }

  /** concurrency slot取得後に1つのGit processを起動して監視する。 */
  private async runProcess(repositoryPath: string, args: readonly string[], options: GitRunOptions): Promise<GitResult> {
    const timeoutMs = options.timeoutMs ?? 15_000;
    const stdoutLimit = options.stdoutLimit ?? DEFAULT_STDOUT_LIMIT;
    const commandArgs = [
      '--no-optional-locks',
      '--no-lazy-fetch',
      '--literal-pathspecs',
      '-c', 'color.ui=false',
      '-c', 'core.pager=cat',
      '-c', 'pager.branch=false',
      '-c', 'pager.log=false',
      '-c', 'pager.diff=false',
      '-c', 'core.fsmonitor=false',
      '-c', 'diff.external=',
      '-c', 'credential.helper=',
      '-C', repositoryPath,
      ...args,
    ];

    return await new Promise<GitResult>((resolve, reject) => {
      const child = spawn('git', commandArgs, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: createIsolatedGitEnvironment(options.environment),
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let truncated = false;
      let settled = false;

      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        callback();
      };
      const abort = (): void => {
        child.kill('SIGKILL');
        finish(() => reject(new Error('Git command aborted.')));
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(() => reject(new Error(`Git command timed out after ${timeoutMs}ms.`)));
      }, timeoutMs);

      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) {
        abort();
        return;
      }

      child.stdout.on('data', (chunk: Buffer) => {
        // 応答上限後もprocessは正常終了できるため、Gitの意味を変えずに
        // 超過byteだけを捨ててmemoryの無制限消費を防ぐ。
        if (stdoutBytes >= stdoutLimit) {
          truncated = true;
          return;
        }
        const remaining = stdoutLimit - stdoutBytes;
        const kept = chunk.subarray(0, remaining);
        stdoutChunks.push(kept);
        stdoutBytes += kept.length;
        if (kept.length < chunk.length) truncated = true;
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderrBytes >= DEFAULT_STDERR_LIMIT) return;
        const kept = chunk.subarray(0, DEFAULT_STDERR_LIMIT - stderrBytes);
        stderrChunks.push(kept);
        stderrBytes += kept.length;
      });
      child.on('error', (error) => finish(() => reject(error)));
      child.on('close', (code) => {
        finish(() => {
          const stdout = Buffer.concat(stdoutChunks).toString('utf8');
          const stderr = Buffer.concat(stderrChunks).toString('utf8');
          const exitCode = code ?? -1;
          if (!(options.acceptedExitCodes ?? [0]).includes(exitCode)) {
            reject(new GitCommandError(stderr.trim() || 'Git command failed.', exitCode, stderr));
            return;
          }
          resolve({ stdout, stderr, exitCode, truncated });
        });
      });
    });
  }

  /**
   * 上限付きprocess slotを取得する。
   *
   * 実行中処理と待機requestの両方を制限し、妥当な参照queryの大量呼び出しで
   * MCP clientがlocal processを枯渇させることを防ぐ。
   */
  private async acquire(): Promise<() => void> {
    if (this.active >= 4) {
      if (this.waiters.length >= 16) {
        throw new Error('Git command queue is full.');
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    return () => {
      this.active -= 1;
      this.waiters.shift()?.();
    };
  }
}