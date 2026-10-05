export type ErrorCode =
  | 'VALIDATION'
  | 'EMPTY_PATTERN'
  | 'DUPLICATE_PATTERN'
  | 'LONE_SURROGATE'
  | 'NOT_FOUND'
  | 'NOT_COMPILED'
  | 'SEQ_CONFLICT'
  | 'SEQ_OUT_OF_ORDER'
  | 'SCAN_FINISHED'
  | 'SCAN_NOT_FINISHED';

export class ApiError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public httpStatus?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function httpStatusFor(code: ErrorCode): number {
  switch (code) {
    case 'NOT_FOUND':
      return 404;
    case 'SEQ_CONFLICT':
    case 'SCAN_FINISHED':
      return 409;
    default:
      return 400;
  }
}
