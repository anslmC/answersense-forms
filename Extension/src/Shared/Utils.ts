export const EXTENSION_NAME = 'AnswerSense: Forms';

export function log(message: string, data?: unknown): void {
  console.log(`[${EXTENSION_NAME}] ${message}`, data);
}
