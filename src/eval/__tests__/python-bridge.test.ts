/**
 * Python Bridge Tests
 *
 * Tests PythonEvalBridge subprocess management, Zod validation,
 * error handling, and temp file lifecycle.
 *
 * Strategy:
 * - Inject a mock execFile function via constructor DI (no vi.mock needed)
 * - Use real temp files for output validation
 * - Test each error scenario with specific error shapes
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { PythonEvalBridge, type ExecFileFn } from '../python-bridge.js';
import { EvalError } from '../types.js';

// ============================================================================
// TEST FIXTURES
// ============================================================================

/** Valid RAGAS output matching RagasOutputSchema */
function makeRagasOutput(overrides: Record<string, unknown> = {}) {
  return {
    scores: { faithfulness: 0.85, answer_relevancy: 0.9 },
    details: [
      { question: 'How does auth work?', scores: { faithfulness: 0.85, answer_relevancy: 0.9 } },
    ],
    metadata: {
      duration_seconds: 12.5,
      model_used: 'gpt-4o-mini',
      metrics_evaluated: ['faithfulness', 'answer_relevancy'],
    },
    ...overrides,
  };
}

/** Valid DeepEval output matching DeepEvalOutputSchema */
function makeDeepEvalOutput(overrides: Record<string, unknown> = {}) {
  return {
    scores: { faithfulness: 0.88, answer_relevancy: 0.92 },
    details: [
      {
        input: 'How does auth work?',
        scores: { faithfulness: 0.88, answer_relevancy: 0.92 },
        reasons: {
          faithfulness: 'Answer is consistent with context',
          answer_relevancy: 'Answer addresses the question directly',
        },
      },
    ],
    metadata: {
      duration_seconds: 15.3,
      model_used: 'gpt-4o-mini',
      metrics_evaluated: ['faithfulness', 'answer_relevancy'],
    },
    ...overrides,
  };
}

/** Valid availability check output */
function makeAvailabilityOutput(overrides: Record<string, unknown> = {}) {
  return {
    python_found: true,
    python_version: '3.11.5',
    ragas_available: true,
    ragas_version: '0.1.10',
    deepeval_available: true,
    deepeval_version: '1.1.6',
    ...overrides,
  };
}

// ============================================================================
// TEST HELPERS
// ============================================================================

let tempDir: string;
let inputPath: string;
let mockExec: ReturnType<typeof vi.fn<ExecFileFn>>;

beforeEach(() => {
  mockExec = vi.fn<ExecFileFn>();

  // Create a temp directory and input file for each test
  tempDir = join(tmpdir(), `ctx-bridge-test-${randomUUID()}`);
  mkdirSync(tempDir, { recursive: true });
  inputPath = join(tempDir, 'input.json');
  writeFileSync(
    inputPath,
    JSON.stringify([{ question: 'test', answer: '', contexts: [], ground_truths: [] }])
  );
});

afterEach(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

/** Create a bridge with the mock exec function */
function createBridge(overrides: Record<string, unknown> = {}) {
  return new PythonEvalBridge({ execFile: mockExec, ...overrides });
}

/**
 * Make the mock exec write a JSON file to the output path argument,
 * simulating what the Python script does.
 *
 * The bridge calls: execFile(pythonPath, ['-c', script, dataPath, outputPath, ...], opts)
 * So args[3] is the output path.
 */
function mockPythonWritesOutput(data: unknown) {
  mockExec.mockImplementation(async (_cmd, args) => {
    const outputPath = args[3]; // ['-c', script, dataPath, outputPath, metrics, model]
    writeFileSync(outputPath, JSON.stringify(data));
    return { stdout: '', stderr: '' };
  });
}

/** Make the mock exec return stdout (for availability check) */
function mockPythonStdout(data: unknown) {
  mockExec.mockResolvedValue({ stdout: JSON.stringify(data), stderr: '' });
}

// ============================================================================
// TESTS: checkAvailability
// ============================================================================

describe('PythonEvalBridge', () => {
  describe('checkAvailability', () => {
    it('returns availability info when python and packages are present', async () => {
      const bridge = createBridge();
      mockPythonStdout(makeAvailabilityOutput());

      const result = await bridge.checkAvailability();

      expect(result).toEqual({
        pythonFound: true,
        pythonVersion: '3.11.5',
        ragasAvailable: true,
        ragasVersion: '0.1.10',
        deepevalAvailable: true,
        deepevalVersion: '1.1.6',
      });
    });

    it('returns pythonFound=false when python is not installed', async () => {
      const bridge = createBridge();
      const enoent = Object.assign(new Error('spawn python3 ENOENT'), { code: 'ENOENT' });
      mockExec.mockRejectedValue(enoent);

      const result = await bridge.checkAvailability();

      expect(result.pythonFound).toBe(false);
      expect(result.ragasAvailable).toBe(false);
      expect(result.deepevalAvailable).toBe(false);
    });

    it('returns partial availability when only ragas is installed', async () => {
      const bridge = createBridge();
      mockPythonStdout(
        makeAvailabilityOutput({ deepeval_available: false, deepeval_version: null })
      );

      const result = await bridge.checkAvailability();

      expect(result.pythonFound).toBe(true);
      expect(result.ragasAvailable).toBe(true);
      expect(result.deepevalAvailable).toBe(false);
    });

    it('uses the configured pythonPath', async () => {
      const bridge = createBridge({ pythonPath: '/usr/local/bin/python3.12' });
      mockPythonStdout(makeAvailabilityOutput());

      await bridge.checkAvailability();

      expect(mockExec).toHaveBeenCalledWith(
        '/usr/local/bin/python3.12',
        expect.arrayContaining(['-c']),
        expect.any(Object)
      );
    });

    it('never throws, even on unexpected errors', async () => {
      const bridge = createBridge();
      mockExec.mockRejectedValue(new Error('something completely unexpected'));

      const result = await bridge.checkAvailability();

      expect(result.pythonFound).toBe(false);
    });
  });

  // ==========================================================================
  // TESTS: runRagas
  // ==========================================================================

  describe('runRagas', () => {
    it('returns validated results from Python subprocess', async () => {
      const bridge = createBridge();
      mockPythonWritesOutput(makeRagasOutput());

      const result = await bridge.runRagas(inputPath, ['faithfulness', 'answer_relevancy']);

      expect(result.scores.faithfulness).toBe(0.85);
      expect(result.scores.answer_relevancy).toBe(0.9);
      expect(result.details).toHaveLength(1);
      expect(result.metadata.model_used).toBe('gpt-4o-mini');
    });

    it('passes dataPath and metrics to Python script args', async () => {
      const bridge = createBridge();
      mockPythonWritesOutput(makeRagasOutput());

      await bridge.runRagas(inputPath, ['faithfulness']);

      const callArgs = mockExec.mock.calls[0];
      const scriptArgs = callArgs[1]; // args array
      // ['-c', script, inputPath, outputPath, metrics, model]
      expect(scriptArgs[2]).toBe(inputPath);
      expect(scriptArgs[4]).toBe('faithfulness');
      expect(scriptArgs[5]).toBe('gpt-4o-mini');
    });

    it('uses configured ragasModel', async () => {
      const bridge = createBridge({ ragasModel: 'glm-4-flash' });
      mockPythonWritesOutput(makeRagasOutput());

      await bridge.runRagas(inputPath, ['faithfulness']);

      const callArgs = mockExec.mock.calls[0];
      const scriptArgs = callArgs[1];
      expect(scriptArgs[5]).toBe('glm-4-flash');
    });

    it('forwards OPENAI_API_KEY to subprocess env', async () => {
      const originalKey = process.env['OPENAI_API_KEY'];
      process.env['OPENAI_API_KEY'] = 'test-key-123';

      try {
        const bridge = createBridge();
        mockPythonWritesOutput(makeRagasOutput());

        await bridge.runRagas(inputPath, ['faithfulness']);

        const callArgs = mockExec.mock.calls[0];
        const options = callArgs[2] as { env: Record<string, string> };
        expect(options.env['OPENAI_API_KEY']).toBe('test-key-123');
      } finally {
        if (originalKey === undefined) delete process.env['OPENAI_API_KEY'];
        else process.env['OPENAI_API_KEY'] = originalKey;
      }
    });

    it('throws EvalError on timeout', async () => {
      const bridge = createBridge({ timeoutMs: 1000 });
      const timeoutError = Object.assign(new Error('killed'), { killed: true });
      mockExec.mockRejectedValue(timeoutError);

      await expect(bridge.runRagas(inputPath, ['faithfulness'])).rejects.toThrow(EvalError);
      await expect(bridge.runRagas(inputPath, ['faithfulness'])).rejects.toThrow(/timed out/);
    });

    it('throws EvalError when python not found', async () => {
      const bridge = createBridge();
      const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      mockExec.mockRejectedValue(enoent);

      await expect(bridge.runRagas(inputPath, ['faithfulness'])).rejects.toThrow(EvalError);
      await expect(bridge.runRagas(inputPath, ['faithfulness'])).rejects.toThrow(/Python not found/);
    });

    it('throws EvalError when input file does not exist', async () => {
      const bridge = createBridge();

      await expect(
        bridge.runRagas('/nonexistent/path.json', ['faithfulness'])
      ).rejects.toThrow(/Input data file not found/);
    });

    it('throws EvalError when no metrics specified', async () => {
      const bridge = createBridge();

      await expect(bridge.runRagas(inputPath, [])).rejects.toThrow(/No metrics specified/);
    });

    it('throws EvalError when output file is missing', async () => {
      const bridge = createBridge();
      // Python "succeeds" but doesn't write the output file
      mockExec.mockResolvedValue({ stdout: '', stderr: '' });

      await expect(bridge.runRagas(inputPath, ['faithfulness'])).rejects.toThrow(
        /produced no output file/
      );
    });

    it('throws EvalError on invalid output JSON', async () => {
      const bridge = createBridge();
      mockPythonWritesOutput({ scores: 'not-an-object' }); // invalid shape

      await expect(bridge.runRagas(inputPath, ['faithfulness'])).rejects.toThrow(
        /Invalid RAGAS output/
      );
    });

    it('throws EvalError when Python writes non-JSON output', async () => {
      const bridge = createBridge();
      mockExec.mockImplementation(async (_cmd, args) => {
        const outputPath = args[3];
        writeFileSync(outputPath, 'not json at all');
        return { stdout: '', stderr: '' };
      });

      await expect(bridge.runRagas(inputPath, ['faithfulness'])).rejects.toThrow(
        /not valid JSON/
      );
    });

    it('includes subprocess stderr in error message', async () => {
      const bridge = createBridge();
      const error = Object.assign(new Error('exit 1'), {
        stderr: 'ModuleNotFoundError: No module named ragas',
        code: 1,
      });
      mockExec.mockRejectedValue(error);

      await expect(bridge.runRagas(inputPath, ['faithfulness'])).rejects.toThrow(
        /ModuleNotFoundError/
      );
    });

    it('cleans up temp output file after success', async () => {
      const bridge = createBridge();
      let capturedOutputPath: string | null = null;

      mockExec.mockImplementation(async (_cmd, args) => {
        capturedOutputPath = args[3];
        writeFileSync(capturedOutputPath, JSON.stringify(makeRagasOutput()));
        return { stdout: '', stderr: '' };
      });

      await bridge.runRagas(inputPath, ['faithfulness']);

      expect(capturedOutputPath).not.toBeNull();
      expect(existsSync(capturedOutputPath!)).toBe(false);
    });

    it('cleans up temp output file after failure', async () => {
      const bridge = createBridge();
      let capturedOutputPath: string | null = null;

      mockExec.mockImplementation(async (_cmd, args) => {
        capturedOutputPath = args[3];
        // Write invalid output to trigger validation error
        writeFileSync(capturedOutputPath, JSON.stringify({ bad: 'data' }));
        return { stdout: '', stderr: '' };
      });

      await expect(bridge.runRagas(inputPath, ['faithfulness'])).rejects.toThrow();

      expect(capturedOutputPath).not.toBeNull();
      expect(existsSync(capturedOutputPath!)).toBe(false);
    });
  });

  // ==========================================================================
  // TESTS: runDeepEval
  // ==========================================================================

  describe('runDeepEval', () => {
    it('returns validated results from Python subprocess', async () => {
      const bridge = createBridge();
      mockPythonWritesOutput(makeDeepEvalOutput());

      const result = await bridge.runDeepEval(inputPath, ['faithfulness', 'answer_relevancy']);

      expect(result.scores.faithfulness).toBe(0.88);
      expect(result.details[0].reasons.faithfulness).toBe('Answer is consistent with context');
      expect(result.metadata.metrics_evaluated).toContain('faithfulness');
    });

    it('throws EvalError on subprocess failure', async () => {
      const bridge = createBridge();
      const error = Object.assign(new Error('exit 1'), { stderr: 'ImportError', code: 1 });
      mockExec.mockRejectedValue(error);

      await expect(bridge.runDeepEval(inputPath, ['faithfulness'])).rejects.toThrow(EvalError);
    });

    it('throws EvalError on invalid DeepEval output (missing reasons)', async () => {
      const bridge = createBridge();
      const badOutput = makeDeepEvalOutput();
      (badOutput.details as Array<Record<string, unknown>>)[0].reasons = 'not-an-object';
      mockPythonWritesOutput(badOutput);

      await expect(bridge.runDeepEval(inputPath, ['faithfulness'])).rejects.toThrow(
        /Invalid DeepEval output/
      );
    });

    it('cleans up temp file in all cases', async () => {
      const bridge = createBridge();
      let capturedOutputPath: string | null = null;

      mockExec.mockImplementation(async (_cmd, args) => {
        capturedOutputPath = args[3];
        writeFileSync(capturedOutputPath, JSON.stringify(makeDeepEvalOutput()));
        return { stdout: '', stderr: '' };
      });

      await bridge.runDeepEval(inputPath, ['faithfulness']);

      expect(capturedOutputPath).not.toBeNull();
      expect(existsSync(capturedOutputPath!)).toBe(false);
    });
  });

  // ==========================================================================
  // TESTS: Zod output validation
  // ==========================================================================

  describe('output validation', () => {
    it('rejects RAGAS scores outside 0-1 range', async () => {
      const bridge = createBridge();
      mockPythonWritesOutput(makeRagasOutput({ scores: { faithfulness: 1.5 } }));

      await expect(bridge.runRagas(inputPath, ['faithfulness'])).rejects.toThrow(
        /Invalid RAGAS output/
      );
    });

    it('rejects DeepEval scores outside 0-1 range', async () => {
      const bridge = createBridge();
      mockPythonWritesOutput(makeDeepEvalOutput({ scores: { faithfulness: -0.1 } }));

      await expect(bridge.runDeepEval(inputPath, ['faithfulness'])).rejects.toThrow(
        /Invalid DeepEval output/
      );
    });

    it('rejects output missing metadata', async () => {
      const bridge = createBridge();
      const { metadata: _, ...noMeta } = makeRagasOutput();
      mockPythonWritesOutput(noMeta);

      await expect(bridge.runRagas(inputPath, ['faithfulness'])).rejects.toThrow(
        /Invalid RAGAS output/
      );
    });

    it('rejects output missing details array', async () => {
      const bridge = createBridge();
      const { details: _, ...noDetails } = makeRagasOutput();
      mockPythonWritesOutput(noDetails);

      await expect(bridge.runRagas(inputPath, ['faithfulness'])).rejects.toThrow(
        /Invalid RAGAS output/
      );
    });
  });

  // ==========================================================================
  // TESTS: Constructor configuration
  // ==========================================================================

  describe('constructor', () => {
    it('uses default values when no config provided', async () => {
      const bridge = createBridge();
      mockPythonStdout(makeAvailabilityOutput());

      await bridge.checkAvailability();

      expect(mockExec).toHaveBeenCalledWith(
        'python3', // default pythonPath
        expect.any(Array),
        expect.objectContaining({ timeout: 300_000 }) // default 5 min
      );
    });

    it('accepts custom timeout', async () => {
      const bridge = createBridge({ timeoutMs: 60_000 });
      mockPythonStdout(makeAvailabilityOutput());

      await bridge.checkAvailability();

      expect(mockExec).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ timeout: 60_000 })
      );
    });
  });
});
