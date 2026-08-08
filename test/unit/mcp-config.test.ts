import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const toolNames = [
  'git_blame',
  'git_compare_refs',
  'git_diff',
  'git_grep',
  'git_list_refs',
  'git_list_remote_refs',
  'git_list_remotes',
  'git_list_repositories',
  'git_list_tree',
  'git_log',
  'git_range_diff',
  'git_read_file',
  'git_show_commit',
  'git_status',
];

describe('MCP client configuration', () => {
  it('uses the git-readonly server name in VS Code', async () => {
    const config = JSON.parse(await readFile('.vscode/mcp.json', 'utf8')) as {
      servers: Record<string, unknown>;
    };

    expect(Object.keys(config.servers)).toEqual(['git-readonly']);
  });

  it('auto-approves every read-only tool in Kiro', async () => {
    const config = JSON.parse(await readFile('.kiro/settings/mcp.json', 'utf8')) as {
      mcpServers: Record<string, { args: string[]; autoApprove: string[] }>;
    };
    const server = config.mcpServers['git-readonly'];

    expect(server).toBeDefined();
    expect([...(server?.autoApprove ?? [])].sort()).toEqual(toolNames);
    expect(server?.autoApprove).not.toContain('git_register_repository');
    expect(server?.args).toContain('--repository-root');
  });
});