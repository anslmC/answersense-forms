export interface QuestionIdentityOptions {
  requireDataParams?: boolean;
}

function parsePayload(raw: string): unknown[] | null {
  if (!raw.startsWith('%.@.')) {
    return null;
  }

  const payload = raw.slice(4);
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;

  for (let index = 0; index < payload.length; index += 1) {
    const character = payload[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === '[') {
      depth += 1;
    } else if (character === ']') {
      depth -= 1;
      if (depth === 0) {
        end = index + 1;
        break;
      }
    }
  }

  if (end < 0) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(payload.slice(0, end));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function extractQuestionId(
  question: HTMLElement,
  _options: QuestionIdentityOptions = {}
): string | null {
  const metadata = Array.from(
    question.querySelectorAll<HTMLElement>('[data-params]')
  );
  if (metadata.length > 1) {
    return null;
  }

  if (metadata.length === 1) {
    const payload = parsePayload(metadata[0].getAttribute('data-params') ?? '');
    const value = payload?.[0];
    if (
      typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value > 0
    ) {
      return String(value);
    }
  }

  const legacyId =
    question.dataset.questionId ??
    question.id ??
    question.getAttribute('aria-labelledby');
  return legacyId?.trim() || null;
}
