import { fill } from '@acme/paths';

export function href(path: string, params: Record<string, string> = {}): string {
  return fill(path, params);
}
