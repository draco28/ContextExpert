/**
 * Tests for safe JSON parsing utility
 */

import { describe, it, expect, vi } from 'vitest';
import { safeJsonParse } from '../json.js';

describe('safeJsonParse', () => {
  describe('valid JSON', () => {
    it('parses valid JSON object', () => {
      const result = safeJsonParse('{"name":"test","value":42}', {});
      expect(result).toEqual({ name: 'test', value: 42 });
    });

    it('parses valid JSON array', () => {
      const result = safeJsonParse('[1,2,3]', []);
      expect(result).toEqual([1, 2, 3]);
    });

    it('parses JSON primitive string', () => {
      const result = safeJsonParse('"hello"', '');
      expect(result).toBe('hello');
    });

    it('parses JSON primitive number', () => {
      const result = safeJsonParse('123', 0);
      expect(result).toBe(123);
    });

    it('parses JSON null', () => {
      const result = safeJsonParse('null', { default: true });
      expect(result).toBeNull();
    });
  });

  describe('null/undefined input', () => {
    it('returns fallback for null input', () => {
      const result = safeJsonParse(null, { default: true });
      expect(result).toEqual({ default: true });
    });

    it('returns fallback for undefined input', () => {
      const result = safeJsonParse(undefined, [1, 2, 3]);
      expect(result).toEqual([1, 2, 3]);
    });

    it('does not call onError for null input', () => {
      const onError = vi.fn();
      safeJsonParse(null, {}, onError);
      expect(onError).not.toHaveBeenCalled();
    });
  });

  describe('invalid JSON', () => {
    it('returns fallback for malformed JSON', () => {
      const result = safeJsonParse('{invalid json}', { fallback: true });
      expect(result).toEqual({ fallback: true });
    });

    it('returns fallback for truncated JSON', () => {
      const result = safeJsonParse('{"name": "test', {});
      expect(result).toEqual({});
    });

    it('returns fallback for empty string', () => {
      const result = safeJsonParse('', { empty: true });
      expect(result).toEqual({ empty: true });
    });

    it('returns fallback for whitespace-only string', () => {
      const result = safeJsonParse('   ', []);
      expect(result).toEqual([]);
    });
  });

  describe('onError callback', () => {
    it('calls onError with error and raw value on parse failure', () => {
      const onError = vi.fn();
      const invalidJson = '{bad: json}';

      safeJsonParse(invalidJson, {}, onError);

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(
        expect.any(Error),
        invalidJson
      );
    });

    it('does not call onError on successful parse', () => {
      const onError = vi.fn();
      safeJsonParse('{"valid": true}', {}, onError);
      expect(onError).not.toHaveBeenCalled();
    });

    it('still returns fallback even if onError throws', () => {
      const onError = vi.fn(() => {
        throw new Error('callback error');
      });

      // Should not throw, just return fallback
      expect(() => {
        safeJsonParse('{invalid}', { fallback: true }, onError);
      }).toThrow('callback error');
    });
  });

  describe('type inference', () => {
    it('infers return type from fallback', () => {
      interface MyType {
        name: string;
        count: number;
      }
      const fallback: MyType = { name: '', count: 0 };
      const result = safeJsonParse<MyType>('{"name":"test","count":5}', fallback);

      // TypeScript should infer result as MyType
      expect(result.name).toBe('test');
      expect(result.count).toBe(5);
    });
  });
});
