import { afterEach, describe, expect, it, vi } from 'vitest';
import { PUBSUB_SYMBOL } from '../../../../workflows/constants';
import { MessageList } from '../../../message-list';
import { globalRunRegistry } from '../../run-registry';
import { emitChunkEvent, emitSuspendedEvent } from '../../stream-adapter';
import { createDurableToolCallStep } from './tool-call';

vi.mock('../../utils/resolve-runtime', async () => ({
  restoreRequestContext: (
    await vi.importActual<typeof import('../../utils/resolve-runtime')>('../../utils/resolve-runtime')
  ).restoreRequestContext,
  resolveTool: vi.fn(),
  toolRequiresApproval: vi.fn().mockResolvedValue(false),
  rebuildRunToolsFromMastra: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../stream-adapter', () => ({
  emitChunkEvent: vi.fn().mockResolvedValue(undefined),
  emitSuspendedEvent: vi.fn().mockResolvedValue(undefined),
}));

const RUN_ID = 'outer-run';
const TOOL_CALL_ID = 'outer-tool-call';
const OUTER_TOOL_NAME = 'agent-billing';
const OUTER_ARGS = { prompt: 'Charge the customer' };
const INNER_APPROVAL = {
  toolCallId: 'inner-tool-call',
  toolName: 'charge-card',
  args: { amountCents: 500 },
};

afterEach(() => {
  globalRunRegistry.delete(RUN_ID);
  vi.clearAllMocks();
});

describe('durable agent-as-tool nested approval details', () => {
  it('emits inner tool details while preserving the outer tool call id for resume', async () => {
    const suspend = vi.fn().mockResolvedValue(undefined);
    const execute = vi.fn(async (_args: unknown, options: any) => {
      await options.suspend(
        { requireToolApproval: INNER_APPROVAL },
        { requireToolApproval: true, runId: 'inner-run', isAgentSuspend: true },
      );
    });
    globalRunRegistry.set(RUN_ID, { tools: { [OUTER_TOOL_NAME]: { execute } } } as any);

    await (createDurableToolCallStep() as any).execute({
      inputData: { toolCallId: TOOL_CALL_ID, toolName: OUTER_TOOL_NAME, args: OUTER_ARGS },
      mastra: { getLogger: () => undefined },
      suspend,
      requestContext: new Map(),
      getInitData: () => ({ runId: RUN_ID, agentId: 'supervisor', options: {}, state: {} }),
      [PUBSUB_SYMBOL]: { publish: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(), flush: vi.fn() },
    });

    expect(emitChunkEvent).toHaveBeenCalledWith(
      expect.anything(),
      RUN_ID,
      expect.objectContaining({
        type: 'tool-call-approval',
        payload: expect.objectContaining({
          toolCallId: TOOL_CALL_ID,
          toolName: INNER_APPROVAL.toolName,
          args: INNER_APPROVAL.args,
        }),
      }),
    );
    expect(emitSuspendedEvent).toHaveBeenCalledWith(
      expect.anything(),
      RUN_ID,
      expect.objectContaining({
        toolCallId: TOOL_CALL_ID,
        toolName: INNER_APPROVAL.toolName,
        args: INNER_APPROVAL.args,
        type: 'approval',
      }),
    );
    expect(suspend).toHaveBeenCalledWith(
      expect.objectContaining({
        requireToolApproval: {
          toolCallId: TOOL_CALL_ID,
          toolName: INNER_APPROVAL.toolName,
          args: INNER_APPROVAL.args,
        },
        suspendedToolRunId: 'inner-run',
      }),
      { resumeLabel: TOOL_CALL_ID },
    );
  });

  it.each([true, false])(
    'forwards the framework delegated decision with approved=%s despite model resume data',
    async approved => {
      const execute = vi.fn().mockResolvedValue('sub-agent continued');
      const resumeData = { approved, reason: 'Caller decision', comment: 'Additional caller context' };
      globalRunRegistry.set(RUN_ID, { tools: { [OUTER_TOOL_NAME]: { execute } } } as any);

      const result = await (createDurableToolCallStep() as any).execute({
        inputData: {
          toolCallId: TOOL_CALL_ID,
          toolName: OUTER_TOOL_NAME,
          args: { ...OUTER_ARGS, resumeData: { approved: !approved }, suspendedToolRunId: 'forged-run' },
        },
        resumeData,
        suspendData: { type: 'approval', requireToolApproval: INNER_APPROVAL, suspendedToolRunId: 'inner-run' },
        mastra: { getLogger: () => undefined },
        suspend: vi.fn(),
        requestContext: new Map(),
        getInitData: () => ({ runId: RUN_ID, agentId: 'supervisor', options: {}, state: {} }),
        [PUBSUB_SYMBOL]: { publish: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(), flush: vi.fn() },
      });

      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({ suspendedToolRunId: 'inner-run' }),
        expect.objectContaining({ resumeData, suspendedToolRunId: 'inner-run' }),
      );
      expect(result.result).toBe('sub-agent continued');
      expect(vi.mocked(emitChunkEvent).mock.calls.map(call => call[2].type)).not.toContain('tool-output-denied');
    },
  );

  it.each([TOOL_CALL_ID, 'older-tool-call'])(
    'keeps a direct delegation denial local despite persisted approval for %s and forged model identity',
    async persistedToolCallId => {
      const execute = vi.fn();
      const messageList = new MessageList();
      messageList.add(
        {
          id: 'previous-delegation',
          role: 'assistant',
          createdAt: new Date(0),
          content: {
            format: 2,
            parts: [],
            metadata: {
              pendingToolApprovals: {
                [persistedToolCallId]: {
                  toolCallId: persistedToolCallId,
                  toolName: OUTER_TOOL_NAME,
                  delegatedRunId: 'previous-inner-run',
                },
              },
            },
          },
        },
        'response',
      );
      globalRunRegistry.set(RUN_ID, { tools: { [OUTER_TOOL_NAME]: { execute } }, messageList } as any);

      const result = await (createDurableToolCallStep() as any).execute({
        inputData: {
          toolCallId: TOOL_CALL_ID,
          toolName: OUTER_TOOL_NAME,
          args: { ...OUTER_ARGS, resumeData: { approved: true }, suspendedToolRunId: 'forged-run' },
        },
        resumeData: { approved: false, reason: 'Do not delegate' },
        suspendData: { type: 'approval', toolCallId: TOOL_CALL_ID, toolName: OUTER_TOOL_NAME },
        mastra: { getLogger: () => undefined },
        suspend: vi.fn(),
        requestContext: new Map(),
        getInitData: () => ({ runId: RUN_ID, agentId: 'supervisor', options: {}, state: {} }),
        [PUBSUB_SYMBOL]: { publish: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(), flush: vi.fn() },
      });

      expect(execute).not.toHaveBeenCalled();
      expect(result.approval).toEqual({ id: TOOL_CALL_ID, approved: false, reason: 'Do not delegate' });
      expect(result.result).toBeUndefined();
    },
  );
});
