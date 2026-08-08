# Git Readonly MCP development instructions

- This project targets Node.js 20+ and the official MCP TypeScript SDK v2: https://ts.sdk.modelcontextprotocol.io/v2/
- The implemented protocol baseline is MCP 2026-07-28: https://modelcontextprotocol.io/specification/2026-07-28
- Keep stdout exclusively for stdio JSON-RPC. Write diagnostics to stderr.
- All Git subprocesses must pass through `GitRunner`; never expose a raw command or raw argument executor as an MCP tool.
- Keep tools read-only and validate repository IDs, revisions, paths, and remote names before invoking Git.
- Add JSDoc to every class, interface, type, method, and function. Add inline comments only for non-obvious WHY decisions, with blank lines between logical processing units.
- Apply SOLID, KISS, YAGNI, and DRY conservatively: keep modules cohesive, inject narrow contracts, avoid speculative abstractions, and centralize repeated security policy.
- Preserve the single-file ESM distribution. Run `npm run check` and `npm run test:integration` after behavior changes.