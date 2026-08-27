import type { ClaudeError, ClaudeErrorCode } from './contracts.js';

const MAX_PROGRESS_ITEMS = 20;
const MAX_PROGRESS_TEXT_LENGTH = 1024;

export class ClaudeStreamError extends Error {
  readonly code: ClaudeErrorCode = 'malformed-stream';

  constructor() {
    super('Received malformed Claude stream output.');
    this.name = 'ClaudeStreamError';
  }
}

export interface ClaudeStreamAccumulator {
  sessionId?: string;
  progressTail: string[];
  result?: string;
  terminal?: 'success' | 'error';
  error?: ClaudeError;
  usage?: Record<string, string | number | boolean | null>;
  totalCostUsd?: number;
  durationMs?: number;
  numTurns?: number;
}

export type ClaudeStreamSnapshot = ClaudeStreamAccumulator;

export function createClaudeStreamAccumulator(): ClaudeStreamAccumulator {
  return { progressTail: [] };
}

function recordProgress(accumulator: ClaudeStreamAccumulator, text: unknown): void {
  if (typeof text !== 'string' || text.length === 0) return;
  accumulator.progressTail.push(text.slice(0, MAX_PROGRESS_TEXT_LENGTH));
  if (accumulator.progressTail.length > MAX_PROGRESS_ITEMS) accumulator.progressTail.shift();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function safeUsage(value: unknown): Record<string, string | number | boolean | null> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const entries = Object.entries(record).filter(([, item]) => (
    item === null || ['string', 'number', 'boolean'].includes(typeof item)
  ));
  return entries.length === 0 ? undefined : Object.fromEntries(entries) as Record<string, string | number | boolean | null>;
}

function setSessionId(accumulator: ClaudeStreamAccumulator, value: unknown): void {
  if (typeof value === 'string' && value.length > 0 && value.length <= 512) accumulator.sessionId = value;
}

function terminalError(accumulator: ClaudeStreamAccumulator): void {
  accumulator.terminal = 'error';
  accumulator.error = { code: 'claude-failed', message: 'Claude execution failed.' };
  delete accumulator.result;
}

function handleAssistant(accumulator: ClaudeStreamAccumulator, event: Record<string, unknown>): void {
  const message = asRecord(event.message);
  const content = message?.content;
  if (!Array.isArray(content)) return;
  for (const part of content) {
    const item = asRecord(part);
    if (item?.type === 'text') recordProgress(accumulator, item.text);
  }
}

function handleStreamEvent(accumulator: ClaudeStreamAccumulator, event: Record<string, unknown>): void {
  const nested = asRecord(event.event);
  if (nested?.type !== 'content_block_delta') return;
  const delta = asRecord(nested.delta);
  if (delta?.type === 'text_delta') recordProgress(accumulator, delta.text);
}

function handleResult(accumulator: ClaudeStreamAccumulator, event: Record<string, unknown>): void {
  setSessionId(accumulator, event.session_id);
  accumulator.usage = safeUsage(event.usage) ?? accumulator.usage;
  if (typeof event.total_cost_usd === 'number' && Number.isFinite(event.total_cost_usd)) accumulator.totalCostUsd = event.total_cost_usd;
  if (typeof event.duration_ms === 'number' && Number.isFinite(event.duration_ms)) accumulator.durationMs = event.duration_ms;
  if (typeof event.num_turns === 'number' && Number.isInteger(event.num_turns)) accumulator.numTurns = event.num_turns;

  if (event.subtype === 'success' && event.is_error !== true) {
    accumulator.terminal = 'success';
    if (typeof event.result === 'string') accumulator.result = event.result;
    delete accumulator.error;
    return;
  }
  if (event.is_error === true || (typeof event.subtype === 'string' && event.subtype.startsWith('error'))) terminalError(accumulator);
}

/** Adds one NDJSON line. Unknown well-formed event types are intentionally ignored. */
export function ingestClaudeStreamLine(accumulator: ClaudeStreamAccumulator, line: string): void {
  if (line.trim() === '') return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new ClaudeStreamError();
  }
  const event = asRecord(parsed);
  if (!event || typeof event.type !== 'string') return;

  switch (event.type) {
    case 'system':
      if (event.subtype === 'init') setSessionId(accumulator, event.session_id);
      break;
    case 'assistant':
      handleAssistant(accumulator, event);
      break;
    case 'stream_event':
      handleStreamEvent(accumulator, event);
      break;
    case 'retry':
    case 'progress':
      recordProgress(accumulator, event.message);
      break;
    case 'result':
      handleResult(accumulator, event);
      break;
    case 'error':
      terminalError(accumulator);
      break;
    default:
      break;
  }
}

export function snapshotClaudeStream(accumulator: ClaudeStreamAccumulator): ClaudeStreamSnapshot {
  return {
    ...(accumulator.sessionId ? { sessionId: accumulator.sessionId } : {}),
    progressTail: [...accumulator.progressTail],
    ...(accumulator.result !== undefined ? { result: accumulator.result } : {}),
    ...(accumulator.terminal ? { terminal: accumulator.terminal } : {}),
    ...(accumulator.error ? { error: { ...accumulator.error } } : {}),
    ...(accumulator.usage ? { usage: { ...accumulator.usage } } : {}),
    ...(accumulator.totalCostUsd !== undefined ? { totalCostUsd: accumulator.totalCostUsd } : {}),
    ...(accumulator.durationMs !== undefined ? { durationMs: accumulator.durationMs } : {}),
    ...(accumulator.numTurns !== undefined ? { numTurns: accumulator.numTurns } : {}),
  };
}
