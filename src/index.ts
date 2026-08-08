import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { parseConfig } from './config.js';
import { createGitQueries } from './git/queries.js';
import { RepositoryRegistry } from './repositories/registry.js';
import { createServer } from './server.js';

/** 依存関係を初期化し、MCP serverをstdioへ接続する。 */
async function main(): Promise<void> {
  const config = parseConfig(process.argv.slice(2));
  const registry = await RepositoryRegistry.create(config.workspaceFolders, config.repositoryRoots);
  const server = createServer(registry, createGitQueries());

  // transport接続後のstdoutはJSON-RPC専用として扱う必要がある。
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`git-readonly-mcp: ${message}\n`);
  process.exitCode = 1;
});