import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..'
);

export function extensionPath(...segments: string[]): string {
  return resolve(extensionRoot, ...segments);
}
