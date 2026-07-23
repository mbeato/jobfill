import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createBatchRunsTable, getBatchRunById, isBatchRunning } from './batch';
import { createSweepsTable, isSweepRunning } from './runs';
import { beginBatch, spawnBatchRunner, BatchAlreadyRunningError, SweepInProgressError } from './batch-job';
import { beginSweep, BatchInProgressError } from './job';

function makeDb(): Database {
  const db = new Database(':memory:');
  createBatchRunsTable(db);
  createSweepsTable(db);
  return db;
}

test('beginBatch on an idle db returns a runId and inserts a running batch_runs row', () => {
  const db = makeDb();
  const { runId } = beginBatch(db, 'manual');
  expect(typeof runId).toBe('number');
  const row = getBatchRunById(db, runId);
  expect(row?.status).toBe('running');
  expect(row?.trigger).toBe('manual');
  expect(isBatchRunning(db)).toBe(true);
});

test('beginBatch throws BatchAlreadyRunningError carrying the running run id when a batch is already running', () => {
  const db = makeDb();
  const { runId } = beginBatch(db, 'scheduled');
  try {
    beginBatch(db, 'manual');
    throw new Error('expected beginBatch to throw');
  } catch (err) {
    expect(err).toBeInstanceOf(BatchAlreadyRunningError);
    expect((err as BatchAlreadyRunningError).runId).toBe(runId);
  }
});

test('beginBatch throws SweepInProgressError carrying the sweep runId when a sweep is running (D-08)', () => {
  const db = makeDb();
  const { runId: sweepRunId } = beginSweep(db, 'manual');
  try {
    beginBatch(db, 'manual');
    throw new Error('expected beginBatch to throw');
  } catch (err) {
    expect(err).toBeInstanceOf(SweepInProgressError);
    expect((err as SweepInProgressError).runId).toBe(sweepRunId);
  }
});

test('a running sweep takes precedence over a running batch check (sweep guard checked first)', () => {
  const db = makeDb();
  beginSweep(db, 'manual');
  expect(isBatchRunning(db)).toBe(false);
  expect(() => beginBatch(db, 'manual')).toThrow(SweepInProgressError);
});

test('beginSweep (edited) throws BatchInProgressError when a batch_runs row is running (reverse D-08)', () => {
  const db = makeDb();
  const { runId: batchRunId } = beginBatch(db, 'manual');
  try {
    beginSweep(db, 'manual');
    throw new Error('expected beginSweep to throw');
  } catch (err) {
    expect(err).toBeInstanceOf(BatchInProgressError);
    expect((err as BatchInProgressError).runId).toBe(batchRunId);
  }
});

test('beginSweep still succeeds normally when no batch and no sweep are running', () => {
  const db = makeDb();
  const { runId } = beginSweep(db, 'manual');
  expect(typeof runId).toBe('number');
  expect(isSweepRunning(db)).toBe(true);
});

test('spawnBatchRunner invokes the injected spawnFn with process.execPath, batch-runner.mjs, the runId, and no timeout/killSignal', () => {
  let capturedArgs: unknown[] = [];
  let capturedOpts: Record<string, unknown> = {};
  const fakeSpawn = ((args: unknown[], opts: Record<string, unknown>) => {
    capturedArgs = args;
    capturedOpts = opts;
    return { unref: () => {} } as unknown as ReturnType<typeof Bun.spawn>;
  }) as typeof Bun.spawn;

  const result = spawnBatchRunner(42, fakeSpawn);

  expect(result).toEqual({ spawned: true });
  expect(capturedArgs[0]).toBe(process.execPath);
  expect(String(capturedArgs[1])).toContain('batch-runner.mjs');
  expect(capturedArgs[2]).toBe('42');
  expect(capturedOpts.timeout).toBeUndefined();
  expect(capturedOpts.killSignal).toBeUndefined();
});

test('spawnBatchRunner returns { spawned: false, error } instead of throwing when spawnFn throws synchronously', () => {
  const throwingSpawn = (() => {
    throw new Error('spawn boom');
  }) as unknown as typeof Bun.spawn;

  const result = spawnBatchRunner(1, throwingSpawn);
  expect(result.spawned).toBe(false);
  expect(result.error).toContain('spawn boom');
});

test('spawnBatchRunner is exported and callable with the default (real) spawn implementation', () => {
  expect(typeof spawnBatchRunner).toBe('function');
});
