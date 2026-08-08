import { McpServer } from '@modelcontextprotocol/server';
import type { GitQueryService } from './git/queries.js';
import type { RepositoryRegistry } from './repositories/registry.js';
import { registerGitTools, registerRepositoryTools } from './tools/git-tools.js';

/**
 * repositoryとqueryの抽象へ依存するMCP serverを生成する。
 *
 * protocol登録をprocess生成やGit実行の詳細から分離するため、
 * 依存関係は外部から注入する。
 */
export function createServer(registry: RepositoryRegistry, queries: GitQueryService): McpServer {
  const server = new McpServer({ name: 'git-readonly-mcp', version: '1.0.0' });

  registerRepositoryTools(server, registry);
  registerGitTools(server, registry, queries);

  return server;
}