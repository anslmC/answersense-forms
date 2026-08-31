// AnswerSense: Forms Data Models
// Placeholder for data validation schemas using Zod

import { z } from 'zod';

// Placeholder schema for form requests
export const FormRequestSchema = z.object({
  formId: z.string(),
  timestamp: z.number(),
});

export type FormRequest = z.infer<typeof FormRequestSchema>;
