import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { GitQueryService, QueryOutput } from '../git/queries.js';
import type { RepositoryRegistry } from '../repositories/registry.js';
import { READ_ONLY_TOOL_ANNOTATIONS } from './metadata.js';

/** すべてのGit query toolで共通利用するrepository selector。 */
const repositoryId = z.string().min(1).describe('ID returned by git_list_repositories');

/** 利用前に不変のcommitへ解決するcommit-ish入力。 */
const revision = z.string().min(1).default('HEAD');

/** repository相対のliteral path入力。 */
const path = z.string().min(1);

/** Git query toolに共通する安定した成功・失敗結果の契約。 */
const outputSchema = z.object({
  output: z.string(),
  truncated: z.boolean(),
  error: z.object({
    code: z.literal('GIT_QUERY_FAILED'),
    message: z.string(),
  }).optional(),
});

/** 設定済みrepository entry 1件のruntime schema。 */
const repositorySchema = z.object({
  repositoryId: z.string(),
  requestedPath: z.string(),
  path: z.string().nullable(),
  name: z.string(),
  available: z.boolean(),
  diagnostic: z.string().nullable(),
});

/** repository検出結果の出力schema。 */
const listRepositoriesOutputSchema = z.object({
  repositories: z.array(repositorySchema),
});

/** 動的repository登録の出力schema。 */
const registerRepositoryOutputSchema = z.object({
  repository: repositorySchema,
});

/** 許可済みrepositoryの検出と動的登録toolを登録する。 */
export function registerRepositoryTools(server: McpServer, registry: RepositoryRegistry): void {
  server.registerTool(
    'git_list_repositories',
    {
      title: 'List Git repositories',
      description: 'List configured workspace folders and whether each is an available Git repository root.',
      inputSchema: z.object({}),
      outputSchema: listRepositoriesOutputSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    () => {
      const result = { repositories: [...registry.list()] };

      // structuredContentを扱わないclient向けにJSON textも返す。
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    'git_register_repository',
    {
      title: 'Register Git repository',
      description: 'Register a Git worktree under a configured repository root and return its repositoryId.',
      inputSchema: z.object({ path: z.string().min(1) }),
      outputSchema: registerRepositoryOutputSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ path: requestedPath }) => {
      try {
        const result = { repository: await registry.register(requestedPath) };

        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Repository registration failed.';

        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ error: { code: 'REPOSITORY_REGISTRATION_FAILED', message } }) }],
        };
      }
    },
  );
}

/** 固定Git参照toolとそのruntime schemaを登録する。 */
export function registerGitTools(server: McpServer, registry: RepositoryRegistry, queries: GitQueryService): void {
  register(
    server,
    'git_status',
    'Show branch and working tree status.',
    z.object({ repositoryId }),
    (input, signal) => queries.status(registry.requirePath(input.repositoryId), signal),
  );

  register(
    server,
    'git_log',
    'Read bounded commit history.',
    z.object({
      repositoryId,
      revision: revision.optional(),
      from: z.string().min(1).optional(),
      to: z.string().min(1).optional(),
      path: path.optional(),
      message: z.string().min(1).optional(),
      author: z.string().min(1).optional(),
      since: z.string().min(1).optional(),
      until: z.string().min(1).optional(),
      firstParent: z.boolean().default(false),
      merges: z.enum(['include', 'only', 'exclude']).default('include'),
      followRenames: z.boolean().default(false)
        .describe('Continue history beyond renames; requires path.'),
      limit: z.number().int().min(1).max(200).default(50),
      offset: z.number().int().min(0).max(10_000).default(0),
    }),
    (input, signal) => queries.log(registry.requirePath(input.repositoryId), input, signal),
  );

  register(
    server,
    'git_show_commit',
    'Show commit metadata, changed files, and optionally its patch.',
    z.object({
      repositoryId,
      revision,
      includePatch: z.boolean().default(true),
      contextLine: z.number().int().min(0).max(100).default(3)
        .describe('Number of unchanged lines shown before and after each patch change.'),
      findRenames: z.boolean().default(true)
        .describe('Detect renamed files regardless of repository diff configuration.'),
      path: path.optional(),
    }),
    (input, signal) => queries.showCommit(registry.requirePath(input.repositoryId), input, signal),
  );

  register(
    server,
    'git_diff',
    'Compare working tree, index, HEAD, or two revisions.',
    z.object({
      repositoryId,
      mode: z.enum(['working', 'staged', 'head', 'revisions']).default('working'),
      base: z.string().min(1).optional(),
      head: z.string().min(1).optional(),
      mergeBase: z.boolean().default(false),
      format: z.enum(['patch', 'stat', 'name-status']).default('patch'),
      contextLine: z.number().int().min(0).max(100).default(3)
        .describe('Number of unchanged lines shown before and after each change in patch format.'),
      findRenames: z.boolean().default(true)
        .describe('Detect renamed files regardless of repository diff configuration.'),
      path: path.optional(),
    }),
    (input, signal) => queries.diff(registry.requirePath(input.repositoryId), input, signal),
  );

  register(
    server,
    'git_range_diff',
    'Compare two commit ranges.',
    z.object({
      repositoryId,
      oldBase: z.string().min(1),
      oldHead: z.string().min(1),
      newBase: z.string().min(1),
      newHead: z.string().min(1),
    }),
    (input, signal) => queries.rangeDiff(
      registry.requirePath(input.repositoryId),
      input.oldBase,
      input.oldHead,
      input.newBase,
      input.newHead,
      signal,
    ),
  );

  register(
    server,
    'git_blame',
    'Show line-level commit attribution for a file.',
    z.object({
      repositoryId,
      revision,
      path,
      start: z.number().int().min(1).optional(),
      end: z.number().int().min(1).optional(),
    }),
    (input, signal) => queries.blame(
      registry.requirePath(input.repositoryId),
      input.revision,
      input.path,
      input.start,
      input.end,
      signal,
    ),
  );

  register(
    server,
    'git_grep',
    'Search tracked content without invoking a shell.',
    z.object({
      repositoryId,
      pattern: z.string().min(1).max(4_096),
      target: z.enum(['working', 'index', 'revision']).default('working'),
      revision: z.string().min(1).optional(),
      path: path.optional(),
      patternType: z.enum(['fixed', 'basic', 'extended']).default('fixed'),
      context: z.number().int().min(0).max(20).default(0),
    }),
    (input, signal) => queries.grep(registry.requirePath(input.repositoryId), input, signal),
  );

  register(
    server,
    'git_list_refs',
    'List local branches, tags, and remote-tracking refs.',
    z.object({
      repositoryId,
      kind: z.enum(['all', 'heads', 'tags', 'remotes']).default('all'),
      limit: z.number().int().min(1).max(1_000).default(200),
    }),
    (input, signal) => queries.listRefs(
      registry.requirePath(input.repositoryId),
      input.kind,
      input.limit,
      signal,
    ),
  );

  register(
    server,
    'git_list_tree',
    'List files and directories at a revision.',
    z.object({
      repositoryId,
      revision,
      path: path.optional(),
      recursive: z.boolean().default(false),
    }),
    (input, signal) => queries.listTree(
      registry.requirePath(input.repositoryId),
      input.revision,
      input.path,
      input.recursive,
      signal,
    ),
  );

  register(
    server,
    'git_read_file',
    'Read a bounded file from a revision, the index, or the working tree.',
    z.object({
      repositoryId,
      target: z.enum(['revision', 'index', 'working']).default('revision'),
      revision,
      path,
      maxBytes: z.number().int().min(1).max(1_048_576).default(262_144),
    }),
    (input, signal) => queries.readFile(registry.requirePath(input.repositoryId), input, signal),
  );

  register(
    server,
    'git_compare_refs',
    'Resolve two refs and report merge base and ahead/behind counts.',
    z.object({
      repositoryId,
      left: z.string().min(1),
      right: z.string().min(1),
    }),
    (input, signal) => queries.compareRefs(
      registry.requirePath(input.repositoryId),
      input.left,
      input.right,
      signal,
    ),
  );

  register(
    server,
    'git_list_remotes',
    'List configured remote names without exposing URLs.',
    z.object({ repositoryId }),
    (input, signal) => queries.listRemotes(registry.requirePath(input.repositoryId), signal),
  );

  register(
    server,
    'git_list_remote_refs',
    'List refs from a configured anonymous public HTTPS remote.',
    z.object({
      repositoryId,
      remote: z.string().min(1),
      limit: z.number().int().min(1).max(1_000).default(200),
    }),
    (input, signal) => queries.listRemoteRefs(
      registry.requirePath(input.repositoryId),
      input.remote,
      input.limit,
      signal,
    ),
    true,
  );
}

/**
 * 検証、出力、error形式を統一したquery toolを1つ登録する。
 *
 * adapterを集約してGit query methodからtransportの関心事を分離し、
 * toolごとの結果形式が不整合になることを防ぐ。
 */
function register<TInput>(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: z.ZodType<TInput>,
  handler: (input: TInput, signal: AbortSignal) => Promise<QueryOutput>,
  openWorld = false,
): void {
  server.registerTool(name, {
    description,
    inputSchema,
    outputSchema,
    annotations: { ...READ_ONLY_TOOL_ANNOTATIONS, openWorldHint: openWorld },
  }, async (input: unknown, context) => {
    try {
      // MCP SDKも入力を検証するが、application境界で再度parseすることで
      // generic handlerの型を絞り込む。
      const result = await handler(inputSchema.parse(input), context.mcpReq.signal);

      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Git query failed.';
      const result = {
        output: '',
        truncated: false,
        error: { code: 'GIT_QUERY_FAILED' as const, message },
      };

      return { isError: true, content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
  });
}