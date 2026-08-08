import { resolve } from 'node:path';

/** コマンドライン引数から解決した実行時設定。 */
export interface ServerConfig {
  workspaceFolders: string[];
  repositoryRoots: string[];
}

/**
 * 意図的に限定したコマンドライン引数を解析する。
 *
 * @param argv Node.jsのentrypointより後ろの引数。
 * @param cwd 相対パスの解決に使う基準ディレクトリ。
 * @returns 検証済みのserver設定。
 */
export function parseConfig(argv: readonly string[], cwd = process.cwd()): ServerConfig {
  const workspaceFolders: string[] = [];
  const repositoryRoots: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== '--workspace-folder' && argument !== '--repository-root') {
      throw new Error(`Unknown argument: ${argument ?? ''}`);
    }

    const folder = argv[index + 1];
    if (!folder || folder.startsWith('-')) {
      throw new Error(`${argument} requires a path.`);
    }
    if (argument === '--workspace-folder') {
      workspaceFolders.push(resolve(cwd, folder));
    } else {
      repositoryRoots.push(resolve(cwd, folder));
    }
    index += 1;
  }

  // 引数なしの直接実行では従来どおり現在ディレクトリを登録し、
  // 同じ範囲に限って動的登録も許可する。
  const useCurrentDirectory = workspaceFolders.length === 0 && repositoryRoots.length === 0;

  return {
    workspaceFolders: useCurrentDirectory ? [resolve(cwd)] : workspaceFolders,
    repositoryRoots: useCurrentDirectory ? [resolve(cwd)] : repositoryRoots,
  };
}