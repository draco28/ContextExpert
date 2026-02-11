/**
 * Eval Types Tests
 *
 * Tests for Zod config schemas and EvalError class from src/eval/types.ts.
 * Covers schema defaults, validation constraints, and error factory methods.
 */

import { describe, it, expect } from 'vitest';
import {
  EvalConfigSchema,
  ObservabilityConfigSchema,
  EvalError,
  EvalErrorCodes,
} from '../types.js';

// ============================================================================
// EvalConfigSchema
// ============================================================================

describe('EvalConfigSchema', () => {
  it('parses with all defaults when given empty object', () => {
    const result = EvalConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.golden_path).toBe('~/.ctx/eval');
      expect(result.data.default_k).toBe(5);
      expect(result.data.python_path).toBe('python3');
      expect(result.data.ragas_model).toBe('gpt-4o-mini');
    }
  });

  it('fills threshold defaults when thresholds object is empty', () => {
    const result = EvalConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.thresholds.mrr).toBe(0.7);
      expect(result.data.thresholds.hit_rate).toBe(0.85);
      expect(result.data.thresholds.precision_at_k).toBe(0.6);
    }
  });

  it('allows partial thresholds with defaults for omitted fields', () => {
    const result = EvalConfigSchema.safeParse({
      thresholds: { mrr: 0.9 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.thresholds.mrr).toBe(0.9);
      expect(result.data.thresholds.hit_rate).toBe(0.85); // default
      expect(result.data.thresholds.precision_at_k).toBe(0.6); // default
    }
  });

  it('accepts full valid config', () => {
    const result = EvalConfigSchema.safeParse({
      golden_path: '/custom/path',
      default_k: 10,
      thresholds: { mrr: 0.8, hit_rate: 0.9, precision_at_k: 0.7 },
      python_path: '/usr/bin/python3',
      ragas_model: 'gpt-4o',
    });
    expect(result.success).toBe(true);
  });

  it('rejects default_k below minimum', () => {
    const result = EvalConfigSchema.safeParse({ default_k: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects default_k above maximum', () => {
    const result = EvalConfigSchema.safeParse({ default_k: 101 });
    expect(result.success).toBe(false);
  });

  it('rejects threshold mrr above 1', () => {
    const result = EvalConfigSchema.safeParse({
      thresholds: { mrr: 1.5 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects threshold mrr below 0', () => {
    const result = EvalConfigSchema.safeParse({
      thresholds: { mrr: -0.1 },
    });
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// ObservabilityConfigSchema
// ============================================================================

describe('ObservabilityConfigSchema', () => {
  it('parses with all defaults when given empty object', () => {
    const result = ObservabilityConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
      expect(result.data.sample_rate).toBe(1.0);
      expect(result.data.langfuse_host).toBe('https://cloud.langfuse.com');
      expect(result.data.langfuse_public_key).toBeUndefined();
      expect(result.data.langfuse_secret_key).toBeUndefined();
    }
  });

  it('accepts full valid config with all fields', () => {
    const result = ObservabilityConfigSchema.safeParse({
      enabled: false,
      sample_rate: 0.5,
      langfuse_public_key: 'pk-lf-test',
      langfuse_secret_key: 'sk-lf-test',
      langfuse_host: 'https://self-hosted.example.com',
    });
    expect(result.success).toBe(true);
  });

  it('rejects sample_rate above 1', () => {
    const result = ObservabilityConfigSchema.safeParse({ sample_rate: 1.5 });
    expect(result.success).toBe(false);
  });

  it('rejects sample_rate below 0', () => {
    const result = ObservabilityConfigSchema.safeParse({ sample_rate: -0.1 });
    expect(result.success).toBe(false);
  });

  it('rejects invalid URL for langfuse_host', () => {
    const result = ObservabilityConfigSchema.safeParse({
      langfuse_host: 'not-a-url',
    });
    expect(result.success).toBe(false);
  });

  it('allows optional langfuse keys to be omitted', () => {
    const result = ObservabilityConfigSchema.safeParse({
      enabled: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.langfuse_public_key).toBeUndefined();
      expect(result.data.langfuse_secret_key).toBeUndefined();
    }
  });
});

// ============================================================================
// EvalError
// ============================================================================

describe('EvalError', () => {
  it('creates error with code and message', () => {
    const error = new EvalError(EvalErrorCodes.EVAL_RUN_FAILED, 'Run failed');

    expect(error.message).toBe('Run failed');
    expect(error.code).toBe('EVAL_RUN_FAILED');
    expect(error.name).toBe('EvalError');
  });

  it('is instanceof Error', () => {
    const error = new EvalError(EvalErrorCodes.EVAL_RUN_FAILED, 'test');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(EvalError);
  });

  it('preserves cause when provided', () => {
    const cause = new Error('underlying problem');
    const error = new EvalError(EvalErrorCodes.EVAL_RUN_FAILED, 'Run failed', cause);

    expect(error.cause).toBe(cause);
  });

  it('has stack trace', () => {
    const error = new EvalError(EvalErrorCodes.EVAL_RUN_FAILED, 'test');

    expect(error.stack).toBeDefined();
    expect(error.stack).toContain('EvalError');
  });

  describe('factory: datasetNotFound', () => {
    it('creates error with correct code and project name', () => {
      const error = EvalError.datasetNotFound('my-project');

      expect(error.code).toBe(EvalErrorCodes.DATASET_NOT_FOUND);
      expect(error.message).toContain('my-project');
      expect(error.message).toContain('ctx eval golden init');
    });
  });

  describe('factory: datasetInvalid', () => {
    it('creates error with correct code and reason', () => {
      const error = EvalError.datasetInvalid('missing entries field');

      expect(error.code).toBe(EvalErrorCodes.DATASET_INVALID);
      expect(error.message).toContain('missing entries field');
    });
  });

  describe('factory: evalRunFailed', () => {
    it('creates error with correct code and preserves cause', () => {
      const cause = new Error('timeout');
      const error = EvalError.evalRunFailed('search timed out', cause);

      expect(error.code).toBe(EvalErrorCodes.EVAL_RUN_FAILED);
      expect(error.message).toContain('search timed out');
      expect(error.cause).toBe(cause);
    });
  });

  describe('factory: langfuseError', () => {
    it('creates error with correct code', () => {
      const error = EvalError.langfuseError('401 unauthorized');

      expect(error.code).toBe(EvalErrorCodes.LANGFUSE_ERROR);
      expect(error.message).toContain('401 unauthorized');
    });
  });

  describe('factory: ragasError', () => {
    it('creates error with correct code', () => {
      const error = EvalError.ragasError('python not found');

      expect(error.code).toBe(EvalErrorCodes.RAGAS_ERROR);
      expect(error.message).toContain('python not found');
    });
  });
});
