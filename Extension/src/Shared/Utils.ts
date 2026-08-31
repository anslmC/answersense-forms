// AnswerSense: Forms Shared Utilities
// Placeholder for shared logic across extension components

export const version = '0.1.0';

export function log(message: string, data?: unknown): void {
  console.log(`[AnswerSense Forms] ${message}`, data);
}
