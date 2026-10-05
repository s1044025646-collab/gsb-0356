import { ApiError } from './errors';

// 拒绝孤立代理项：高代理后未跟低代理，或低代理前没有高代理。
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

export function toCodePoints(text: string, field: string): string[] {
  if (typeof text !== 'string') {
    throw new ApiError('VALIDATION', `${field} 必须是字符串`);
  }
  if (LONE_SURROGATE.test(text)) {
    throw new ApiError(
      'LONE_SURROGATE',
      `${field} 包含孤立代理项（lone surrogate），不是完整有效的 Unicode 字符串`,
    );
  }
  return Array.from(text);
}

export interface PatternInput {
  text: string;
  cps: string[];
}

export function validatePatterns(raw: unknown): PatternInput[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ApiError('VALIDATION', 'patterns 必须是非空字符串数组');
  }
  const seen = new Set<string>();
  const result: PatternInput[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') {
      throw new ApiError('VALIDATION', '每个模式必须是字符串');
    }
    const cps = toCodePoints(item, 'pattern');
    if (cps.length === 0) {
      throw new ApiError('EMPTY_PATTERN', '模式不能为空字符串');
    }
    if (seen.has(item)) {
      throw new ApiError('DUPLICATE_PATTERN', `重复的模式文本: ${JSON.stringify(item)}`);
    }
    seen.add(item);
    result.push({ text: item, cps });
  }
  return result;
}
