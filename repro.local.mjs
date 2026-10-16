import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Agent } from '../packages/core/dist/agent/index.js';
import { Mastra } from '../packages/core/dist/mastra/index.js';
import { createTool } from '../packages/core/dist/tools/index.js';
import { InMemoryStore } from '../packages/core/dist/storage/index.js';
import { MastraClient } from '../client-sdks/client-js/dist/index.js';
import { MastraServer } from '../server-adapters/hono/dist/index.js';
import { Memory } from '../packages/memory/dist/index.js';
import { MockLanguageModelV3, convertArrayToReadableStream } from '../packages/_vendored/ai_v6/dist/test.js';
import { z } from 'zod';

const require = createRequire(new URL('../server-adapters/hono/package.json', import.meta.url));
const { Hono } = require('hono');
const { serve } = require('@hono/node-server');
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const step = prompt => {
  const results = prompt.flatMap(m => m.role === 'tool' ? m.content : []).map(p => p.toolName);
  if (process.env.TRACE_REPRO) console.error(JSON.stringify({ prompt }));
  if (!results.includes('gated_action')) return { tool: 'gated_action', args: { value: 'local-only' } };
  if (!results.includes('weather')) return { tool: 'weather', args: { city: 'Paris' } };
  return { text: 'Weather received' };
};
const model = () => new MockLanguageModelV3({
  doStream: async ({ prompt }) => {
    const next = step(prompt);
    const parts = next.tool
      ? [{ type: 'tool-call', toolCallId: `${next.tool}-1`, toolName: next.tool, input: JSON.stringify(next.args) }]
      : [{ type: 'text-start', id: 'text' }, { type: 'text-delta', id: 'text', delta: next.text }, { type: 'text-end', id: 'text' }];
    return {
      stream: convertArrayToReadableStream([
        { type: 'stream-start', warnings: [] },
        ...parts,
        { type: 'finish', finishReason: { unified: next.tool ? 'tool-calls' : 'stop', raw: next.tool ? 'tool_calls' : 'stop' }, usage },
      ]),
    };
  },
  doGenerate: async ({ prompt }) => {
    const next = step(prompt);
    return {
      content: next.tool
        ? [{ type: 'tool-call', toolCallId: `${next.tool}-1`, toolName: next.tool, input: JSON.stringify(next.args) }]
        : [{ type: 'text', text: next.text }],
      finishReason: { unified: next.tool ? 'tool-calls' : 'stop', raw: next.tool ? 'tool_calls' : 'stop' },
      usage,
      warnings: [],
    };
  },
});
let serverExecutions = 0;
let clientExecutions = 0;
const gated_action = createTool({
  id: 'gated_action',
  description: 'An offline action that requires approval',
  inputSchema: z.object({ value: z.string() }),
  requireApproval: true,
  execute: async () => { serverExecutions++; return { accepted: true }; },
});
const weather = createTool({
  id: 'weather',
  description: 'Return a fixed local weather reading',
  inputSchema: z.object({ city: z.string() }),
  execute: async () => { clientExecutions++; return { temperature: 20 }; },
});
const storage = new InMemoryStore();
const payer = new Agent({
  id: 'approval-repro', name: 'Approval reproduction', instructions: 'Use the tools.',
  model: model(), tools: { gated_action },
  memory: new Memory({ storage, options: { semanticRecall: false, generateTitle: false } }),
});
const mastra = new Mastra({ agents: { payer }, storage, logger: false });
const requests = [];
const app = new Hono();
app.use('*', async (c, next) => {
  if (c.req.method === 'POST') {
    const body = await c.req.raw.clone().json();
    requests.push({
      path: c.req.path,
      clientTools: Object.keys(body.clientTools ?? {}),
      inputSchema: body.clientTools?.weather?.inputSchema,
    });
  }
  await next();
});
await new MastraServer({ app, mastra }).init();
const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
await new Promise(resolve => server.listening ? resolve() : server.once('listening', resolve));
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}`;
const client = new MastraClient({ baseUrl, retries: 0 });
const agent = client.getAgent('payer');
const clientTools = { weather };
const read = async response => {
  const chunks = [];
  await response.processDataStream({ onChunk: async chunk => { chunks.push(chunk); } });
  return chunks;
};
const checks = [];
try {
  for (const method of ['approveToolCall', 'declineToolCall', 'approveToolCallGenerate', 'declineToolCallGenerate']) {
    const requestContext = { mastra__resourceId: 'local-user', mastra__threadId: `local-${method}` };
    const memory = { thread: `local-${method}`, resource: 'local-user' };
    const start = await read(await agent.stream('Run the local action then check weather', { clientTools, requestContext, memory }));
    const runId = start.find(c => c.runId)?.runId;
    const toolCallId = start.find(c => c.type === 'tool-call-approval')?.payload?.toolCallId;
    assert.ok(runId && toolCallId, 'run must suspend for approval');
    const serverBefore = serverExecutions;
    const clientBefore = clientExecutions;
    const requestStart = requests.length;
    const options = { runId, toolCallId, clientToolsResolver: () => clientTools, requestContext, memory };
    let summary;
    if (method.endsWith('Generate')) {
      const result = await agent[method](options);
      const toolNames = result.toolCalls?.map(c => c.payload?.toolName ?? c.toolName) ?? [];
      summary = { finishReason: result.finishReason, toolNames };
      checks.push(result.finishReason === 'tool-calls' && toolNames.includes('weather'));
    } else {
      const chunks = await read(await agent[method](options));
      summary = {
        text: chunks.filter(c => c.type === 'text-delta').map(c => c.payload.text).join(''),
        toolErrors: chunks.filter(c => c.type === 'tool-error').map(c => c.payload.error),
      };
      checks.push(summary.text === 'Weather received' && summary.toolErrors.length === 0 && clientExecutions - clientBefore === 1);
    }
    checks.push(serverExecutions - serverBefore === (method.startsWith('approve') ? 1 : 0));
    console.log(JSON.stringify({
      method, ...summary,
      serverExecutions: serverExecutions - serverBefore,
      clientExecutions: clientExecutions - clientBefore,
      requests: requests.slice(requestStart),
    }, null, 2));
  }
  console.log(`VERDICT ${checks.every(Boolean) ? 'PASS' : 'FAIL'} (${checks.filter(Boolean).length}/${checks.length} checks)`);
  process.exitCode = checks.every(Boolean) ? 0 : 1;
} finally {
  await new Promise(resolve => server.close(resolve));
  await mastra.getStorage()?.close();
}
