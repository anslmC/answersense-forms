export const EXTENSION_NAME = 'AnswerSense: Forms';
export const EXTENSION_VERSION = '0.1.0';
export const GOOGLE_FORMS_MATCHES = ['https://docs.google.com/forms/*'];

export function log(message: string, data?: unknown): void {
  console.log(`[${EXTENSION_NAME}] ${message}`, data);
}
