// AnswerSense: Forms Data Models
// Placeholder for data validation schemas using Zod

import { z } from 'zod';
import { SUPPORTED_QUESTION_TYPES } from '../../../Shared/QuestionTypes.js';

const answerValueSchema = z.union([z.string(), z.array(z.string())]);

const generationQuestionSchema = z.object({
  questionId: z.string().min(1),
  text: z.string(),
  type: z.enum(SUPPORTED_QUESTION_TYPES),
  required: z.boolean(),
  options: z.array(z.string()),
});

const settledContextItemSchema = z.object({
  questionId: z.string().min(1),
  questionText: z.string(),
  answer: answerValueSchema,
});

const generatedQuestionResultSchema = z
  .object({
    questionId: z.string().min(1),
    status: z.literal('GENERATED'),
    answer: z.object({
      questionId: z.string().min(1),
      value: answerValueSchema,
    }),
  })
  .superRefine((result, context) => {
    if (result.answer.questionId !== result.questionId) {
      context.addIssue({
        code: 'custom',
        path: ['answer', 'questionId'],
        message: 'answer.questionId must match result.questionId',
      });
    }
  });
const abstainedQuestionResultSchema = z.object({
  questionId: z.string().min(1),
  status: z.literal('ABSTAINED'),
  answer: z.null(),
  reason: z.enum(['LOW_CONFIDENCE', 'UNABLE_TO_DETERMINE', 'NOT_APPLICABLE']),
});

const failedQuestionResultSchema = z.object({
  questionId: z.string().min(1),
  status: z.literal('GENERATION_FAILED'),
  answer: z.null(),
  failure: z.object({
    code: z.string().min(1),
    message: z.string(),
  }),
});

export const GenerationRequestSchema = z.object({
  cycleId: z.string().min(1),
  pageId: z.string().min(1),
  questions: z.array(generationQuestionSchema),
  settledContext: z.array(settledContextItemSchema),
});

export const GenerationResponseSchema = z
  .object({
    cycleId: z.string().min(1),
    results: z.array(
      z.discriminatedUnion('status', [
        generatedQuestionResultSchema,
        abstainedQuestionResultSchema,
        failedQuestionResultSchema,
      ])
    ),
  })
  .superRefine((response, context) => {
    const seenQuestionIds = new Set<string>();
    response.results.forEach((result, index) => {
      if (seenQuestionIds.has(result.questionId)) {
        context.addIssue({
          code: 'custom',
          path: ['results', index, 'questionId'],
          message: 'result questionId values must be unique',
        });
      }
      seenQuestionIds.add(result.questionId);
    });
  });
