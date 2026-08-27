import { describe, expect, it } from 'vitest';
import {
  ClaudeStreamError,
  createClaudeStreamAccumulator,
  ingestClaudeStreamLine,
  snapshotClaudeStream,
} from '../src/stream-parser.js';

describe('incremental Claude stream parser', () => {
  it('captures init session, text progress, and normalized successful result metadata', () => {
    const accumulator = createClaudeStreamAccumulator();
    ingestClaudeStreamLine(accumulator, '{"type":"system","subtype":"init","session_id":"sess_1"}');
    ingestClaudeStreamLine(accumulator, '{"type":"assistant","message":{"content":[{"type":"text","text":"Thinking"}]}}');
    ingestClaudeStreamLine(accumulator, '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":" more"}}}');
    ingestClaudeStreamLine(accumulator, '{"type":"result","subtype":"success","result":"Finished safely","session_id":"sess_1","usage":{"input_tokens":10,"output_tokens":5,"prompt":"private","authorization":"Bearer synthetic-value","identity":"user@example.test"},"total_cost_usd":0.02,"duration_ms":123,"num_turns":2}');

    expect(snapshotClaudeStream(accumulator)).toEqual({
      sessionId: 'sess_1', progressTail: ['Thinking', ' more'], result: 'Finished safely',
      terminal: 'success', usage: { input_tokens: 10, output_tokens: 5 }, totalCostUsd: 0.02, durationMs: 123, numTurns: 2,
    });
  });

  it('normalizes known terminal error result variants without retaining tool output', () => {
    const accumulator = createClaudeStreamAccumulator();
    ingestClaudeStreamLine(accumulator, '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"sensitive"}}]}}');
    ingestClaudeStreamLine(accumulator, '{"type":"result","subtype":"error_during_execution","error":{"message":"Child exited"},"result":"not retained as successful"}');

    expect(snapshotClaudeStream(accumulator)).toEqual({
      progressTail: [], terminal: 'error', error: {
        code: 'claude-failed', message: 'Claude execution failed.', subtype: 'error_during_execution',
      },
    });
  });

  it('records retry and progress families, normalizes known error events, and freezes the first terminal result', () => {
    const accumulator = createClaudeStreamAccumulator();
    ingestClaudeStreamLine(accumulator, '{"type":"retry","message":"Retrying"}');
    ingestClaudeStreamLine(accumulator, '{"type":"progress","message":"Waiting"}');
    ingestClaudeStreamLine(accumulator, '{"type":"error","error":{"type":"authentication_error"}}');
    ingestClaudeStreamLine(accumulator, '{"type":"result","subtype":"success","result":"must not replace error"}');
    ingestClaudeStreamLine(accumulator, '{"type":"assistant","message":{"content":[{"type":"text","text":"must not append"}]}}');

    expect(snapshotClaudeStream(accumulator)).toEqual({
      progressTail: ['Retrying', 'Waiting'], terminal: 'error',
      error: { code: 'auth-required', message: 'Claude execution failed.', subtype: 'error_auth' },
    });
  });

  it('does not expose unknown result error subtypes or mutate a successful terminal result', () => {
    const accumulator = createClaudeStreamAccumulator();
    ingestClaudeStreamLine(accumulator, '{"type":"result","subtype":"success","result":"safe"}');
    ingestClaudeStreamLine(accumulator, '{"type":"result","subtype":"future_private_failure","is_error":true,"error":{"message":"private"}}');

    expect(snapshotClaudeStream(accumulator)).toEqual({ progressTail: [], terminal: 'success', result: 'safe' });
  });

  it('maps known result limits to a safe stable error without accepting raw error text', () => {
    const accumulator = createClaudeStreamAccumulator();
    ingestClaudeStreamLine(accumulator, '{"type":"result","subtype":"error_max_turns","is_error":true,"error":{"message":"private"}}');

    expect(snapshotClaudeStream(accumulator)).toEqual({
      progressTail: [], terminal: 'error',
      error: { code: 'output-limited', message: 'Claude execution failed.', subtype: 'error_max_turns' },
    });
  });

  it('ignores unknown well-formed event types and bounds the progress tail', () => {
    const accumulator = createClaudeStreamAccumulator();
    ingestClaudeStreamLine(accumulator, '{"type":"future_event","payload":{"untrusted":"ignored"}}');
    for (let index = 0; index < 25; index += 1) {
      ingestClaudeStreamLine(accumulator, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `p${index}` }] } }));
    }

    expect(snapshotClaudeStream(accumulator).progressTail).toEqual([
      'p5', 'p6', 'p7', 'p8', 'p9', 'p10', 'p11', 'p12', 'p13', 'p14', 'p15', 'p16', 'p17', 'p18', 'p19',
      'p20', 'p21', 'p22', 'p23', 'p24',
    ]);
  });

  it('raises a stable error for malformed nonblank JSON without leaking the line', () => {
    expect(() => ingestClaudeStreamLine(createClaudeStreamAccumulator(), '   ')).not.toThrow();
    const malformed = '{ definitely not valid JSON and must remain private';
    expect(() => ingestClaudeStreamLine(createClaudeStreamAccumulator(), malformed)).toThrow(ClaudeStreamError);
    try {
      ingestClaudeStreamLine(createClaudeStreamAccumulator(), malformed);
    } catch (error) {
      expect(error).toMatchObject({ code: 'malformed-stream', message: 'Received malformed Claude stream output.' });
      expect(String(error)).not.toContain(malformed);
    }
  });
});
