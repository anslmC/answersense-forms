import type { AnswerValue } from '../Models/Logical';

export const EXTENSION_NAME = 'AnswerSense: Forms';

export function cloneAnswerValue(value: AnswerValue): AnswerValue;
export function cloneAnswerValue(value: AnswerValue | null): AnswerValue | null;
export function cloneAnswerValue(
  value: AnswerValue | null
): AnswerValue | null {
  return Array.isArray(value) ? [...value] : value;
}

export function log(message: string, data?: unknown): void {
  console.log(`[${EXTENSION_NAME}] ${message}`, data);
}
