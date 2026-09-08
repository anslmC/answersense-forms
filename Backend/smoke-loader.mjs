import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function resolve(specifier, context, nextResolve) {
  const filename = specifier.slice(specifier.lastIndexOf('/') + 1);

  if (specifier.startsWith('.') && !filename.includes('.')) {
    const candidate = new URL(`${specifier}.js`, context.parentURL);

    try {
      await access(fileURLToPath(candidate));
      return nextResolve(`${specifier}.js`, context);
    } catch {
      // Let Node report the original resolution error when no .js file exists.
    }
  }

  return nextResolve(specifier, context);
}
