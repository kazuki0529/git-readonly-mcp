# Git Readonly MCP

Gitの履歴、差分、参照、ファイル内容をAIセルフレビューへ渡すためのread-only MCPサーバーです。Kiro、Claude Code、Claude Desktop、VS Codeから、同じローカルstdioサーバーを利用できます。

任意のGitコマンド実行機能は公開しません。起動時に許可したworkspace folder、またはrepository root配下に対し、用途別の型付きツールだけを提供します。

## Requirements

- Node.js 20以上
- Git 2.43以上を推奨
- 信頼できるローカルGitリポジトリ

## Build

```bash
npm ci
npm run check
npm run test:integration
```

成果物は依存関係を含む単一ファイルです。

```text
dist/git-readonly-mcp.mjs
```

直接起動する場合:

```bash
node /path/to/git-readonly-mcp/dist/git-readonly-mcp.mjs \
  --workspace-folder /path/to/frontend \
  --workspace-folder /path/to/backend \
  --repository-root /path/to/projects
```

`--workspace-folder`を省略した場合は、プロセスの現在ディレクトリだけを候補にします。指定したfolder自体がGit worktreeのルートでなければ利用不可として一覧へ表示し、親や子のリポジトリは自動探索しません。

`--repository-root`は、AIが`git_register_repository`で後から登録できる親ディレクトリです。指定した親そのものと配下だけを許可し、symlinkを解決した実体が範囲外なら拒否します。任意パスを無制限に許可するoptionはありません。

## Placement

個人で複数プロジェクトから利用する場合は、bundleをユーザーディレクトリへ1つだけ置く構成を推奨します。

```text
~/.mcp/git-readonly/git-readonly-mcp.mjs
```

MCP設定ではこのbundleを絶対パスで指定し、repositoryの許可範囲だけをclient側の`--workspace-folder`または`--repository-root`で渡します。bundleの配置場所とGitへのアクセス許可は分離されています。プロジェクト内への配置は、teamで同じversionを固定し、設定もrepositoryで共有したい場合に適しています。

## Client configuration

### VS Code

単一root用の設定は [.vscode/mcp.json](.vscode/mcp.json) に含まれています。multi-root workspaceでは、workspace folder名を明示します。

```json
{
  "servers": {
    "git-readonly": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/absolute/path/to/git-readonly-mcp.mjs",
        "--workspace-folder",
        "${workspaceFolder:Frontend}",
        "--workspace-folder",
        "${workspaceFolder:Backend}",
        "--repository-root",
        "${workspaceFolder}"
      ]
    }
  }
}
```

### Kiro

このリポジトリを直接開く場合の設定は [.kiro/settings/mcp.json](.kiro/settings/mcp.json) に含まれています。別プロジェクトから利用する場合はbundleとrepositoryを絶対パスで指定します。
提供する15ツールのうち、14個のGit参照ツールはread-onlyとして`autoApprove`へ明示的に列挙しています。`git_register_repository`はserverが読める範囲を広げるため、自動承認から除外しています。

```json
{
  "mcpServers": {
    "git-readonly": {
      "command": "node",
      "args": [
        "/absolute/path/to/git-readonly-mcp.mjs",
        "--repository-root",
        "/absolute/path/to/projects"
      ],
      "disabled": false,
      "autoApprove": [
        "git_list_repositories",
        "git_status",
        "git_log",
        "git_show_commit",
        "git_diff",
        "git_range_diff",
        "git_blame",
        "git_grep",
        "git_list_refs",
        "git_list_tree",
        "git_read_file",
        "git_compare_refs",
        "git_list_remotes",
        "git_list_remote_refs"
      ]
    }
  }
}
```

### Claude Code

```bash
claude mcp add --transport stdio --scope project git-readonly -- \
  node /absolute/path/to/git-readonly-mcp.mjs \
  --workspace-folder /absolute/path/to/repository
```

またはproject rootの `.mcp.json` に設定します。

```json
{
  "mcpServers": {
    "git-readonly": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/absolute/path/to/git-readonly-mcp.mjs",
        "--workspace-folder",
        "/absolute/path/to/repository"
      ]
    }
  }
}
```

### Claude Desktop

Developer settingsの `claude_desktop_config.json` に同じstdio起動設定を追加します。

```json
{
  "mcpServers": {
    "git-readonly": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/absolute/path/to/git-readonly-mcp.mjs",
        "--workspace-folder",
        "/absolute/path/to/repository"
      ]
    }
  }
}
```

Claude Desktop向けのワンクリック配布用 `.mcpb` は現在の成果物には含まれません。

## Tools

| Tool | Purpose |
|---|---|
| `git_list_repositories` | 設定済みfolderと`repositoryId`を一覧化 |
| `git_register_repository` | 許可されたroot配下のworktreeを登録 |
| `git_status` | branch、staged、unstaged、untracked状態を取得 |
| `git_log` | revision、期間、author、message、pathで履歴を検索 |
| `git_show_commit` | commit metadata、stat、任意のpatchを取得 |
| `git_diff` | working tree、index、2 revisionを比較 |
| `git_range_diff` | 2つのcommit rangeを比較 |
| `git_blame` | fileの行単位attributionを取得 |
| `git_grep` | working tree、index、revisionの内容を検索 |
| `git_list_refs` | branch、tag、remote-tracking refを一覧化 |
| `git_list_tree` | revision時点のtreeを一覧化 |
| `git_read_file` | revision時点のbounded blobを取得 |
| `git_compare_refs` | merge baseとahead/behind件数を取得 |
| `git_list_remotes` | URLを開示せずremote名を一覧化 |
| `git_list_remote_refs` | 設定済みpublic anonymous HTTPS remoteのrefを取得 |

最初に`git_list_repositories`を呼びます。対象が未登録なら`git_register_repository`へpathを渡し、返された`repositoryId`を以後のツールへ渡します。ツール結果は`structuredContent`とJSON textの両方で返されます。

## Security model

- Gitはshellを介さず `spawn` します。
- pager、external diff、textconv、credential helper、interactive prompt、optional lock、lazy fetchを抑止します。
- revision rangeは個別parameterからサーバー側で構築します。
- file pathはrepository-relative literalだけを許可します。
- 動的repository登録は、起動時の`--repository-root`をcanonical pathで検証した配下だけに制限します。
- local queryは既定15秒、blameとrange-diffは30秒、remote queryは10秒で停止します。
- stdoutは1 MiB、stderrは64 KiBを上限とします。
- remote問い合わせは設定済みremote名だけを受け取り、資格情報のないHTTPS URLかつpublic IPへ解決される場合だけ `ls-remote` を実行します。
- SSH、HTTP、file URL、private/local address、fetch、pull、push、cloneは許可しません。

このサーバーはsandboxではありません。Git自体が読むrepository metadataを含め、信頼できるworkspaceだけを登録してください。

## Development

```bash
npm run dev -- --workspace-folder /path/to/repository
npm run lint
npm run typecheck
npm test
npm run build
npm run test:integration
npm run pack:dry-run
```

MCP Inspectorで確認する場合:

```bash
npx @modelcontextprotocol/inspector node dist/git-readonly-mcp.mjs \
  --workspace-folder /path/to/repository
```

ログはstderrへ出力してください。stdio MCPのstdoutへ診断メッセージを出すとJSON-RPC通信が壊れます。