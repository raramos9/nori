export class NoriError extends Error {
  override name = 'NoriError';
}

export function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined;
}
