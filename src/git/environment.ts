/**
 * すべてのGit subprocessで共有する最小限の環境変数を構築する。
 *
 * ユーザー管理のGit環境変数は、外部helperやprompt、repository外の設定を
 * 有効化できるため継承しない。明示的な上書きは、より厳しい制約が必要な
 * 呼び出し元だけが指定する。
 */
export function createIsolatedGitEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    ...overrides,
  };
}