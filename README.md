# Mastra #27186 verification evidence

Baseline: `75312e3acd7a8dfa1725a7d75706495c12dd8be1`. Fixed source: `4e512457a12d75efc68908237d2479d17ec56afe`.

The same local reproduction was run against both revisions. It starts a real Hono HTTP server on loopback and uses the built client SDK, real Agent approval/resume code, Memory, and InMemoryStore. Only model responses and the local weather tool output are scripted. This does not verify a live provider, durable-agent restart, browser UI, or production authentication.

| Case | Baseline | Fixed |
| --- | --- | --- |
| approve stream | ToolNotFoundError, no client execution | Client tool executes once, response completes |
| decline stream | ToolNotFoundError, no client execution | Client tool executes once, gated action never executes |
| approve generate | ToolNotFoundError consumed, finish reason stop | Client tool call returned with tool-calls |
| decline generate | ToolNotFoundError consumed, finish reason stop | Client tool call returned with tool-calls, gated action never executes |

The non-streaming approval methods return client tool calls; they do not execute client tools locally. Streaming continuations pass the original memory configuration, as documented in the change. Stateless conversation-history replay is not claimed.

## Reproduce

At either source revision, install locked dependencies and build the relevant packages.

```sh
pnpm install --frozen-lockfile
pnpm turbo build --filter=@mastra/client-js --filter=@mastra/server --filter=@mastra/hono
```

Save `repro.local.mjs` as `.context/approval-client-tools.local.mjs` at the repository root, then run:

```sh
node .context/approval-client-tools.local.mjs
```

The baseline exits 1 with 4/8 checks, the fixed revision exits 0 with 8/8 checks. No credentials, provider calls, payments, or external databases are used.

The 12 new runtime regressions were also run on unchanged production source: 6 client and 6 server failures. After the change, the complete client suite has 778 passing tests, server 2906 passing with 3 skipped and 1 todo, CLI 1637 passing with 3 skipped, and create-mastra 12 passing. Client/server and CLI builds and primary typechecks pass. Focused route type contracts pass. The wider client type-test project still reports the same two TraceQuery errors on the unchanged baseline and fixed branch.

Documentation formatting, Remark, Vale, and the production docs build pass. The docs build reports anchor warnings outside the changed page; a full baseline docs build was not run. No full monorepo or live-provider test is claimed. This evidence was produced and reviewed by OpenAI Codex; no human review is claimed.

Machine-specific checkout paths and terminal formatting have been removed from the copied logs. No test results have been changed.
