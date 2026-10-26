import { z } from "zod";

const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

export const aiSummarizeSchema = z.strictObject({
  projectId: uuid,
});

export const aiAssistantSchema = z.strictObject({
  projectId: uuid,
  question: z.string().trim().min(1).max(1000),
});

export const aiRiskSchema = z.strictObject({
  projectId: uuid,
});

export const aiPlanningGenerateSchema = z.strictObject({
  goal: z.string().trim().min(10).max(2000),
});

// Structured provider outputs are validated strictly: an unexpected
// shape is a provider failure, never partially applied data.
export const aiPlanningOutputSchema = z.strictObject({
  milestones: z
    .array(
      z.strictObject({
        name: z.string().trim().min(1).max(160),
        description: z.string().trim().max(2000).optional(),
        tasks: z
          .array(
            z.strictObject({
              title: z.string().trim().min(1).max(200),
              description: z.string().trim().max(2000).optional(),
              subtasks: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
            }),
          )
          .min(1)
          .max(30),
      }),
    )
    .min(1)
    .max(20),
  dependencies: z
    .array(
      z.strictObject({
        from: z.string().trim().min(1).max(200),
        to: z.string().trim().min(1).max(200),
      }),
    )
    .max(50)
    .optional(),
});

export type AiPlanningOutput = z.infer<typeof aiPlanningOutputSchema>;

// The confirm draft must match the provider-output shape exactly: it
// is validated again here because the client echoes it back, and a
// tampered draft must fail validation rather than create bad data.
// Declared after aiPlanningOutputSchema to avoid a TDZ error.
export const aiPlanningConfirmSchema = z.strictObject({
  projectName: z.string().trim().min(1).max(160),
  draft: aiPlanningOutputSchema,
});

export const aiExtractionOutputSchema = z.strictObject({
  tasks: z
    .array(
      z.strictObject({
        title: z.string().trim().min(1).max(200),
        owner: z.string().trim().max(160).nullable().optional(),
        deadline: z.string().trim().max(40).nullable().optional(),
      }),
    )
    .max(50),
  decisions: z.array(z.string().trim().min(1).max(1000)).max(50),
  followUps: z.array(z.string().trim().min(1).max(1000)).max(50),
  risks: z.array(z.string().trim().min(1).max(1000)).max(50),
});

export type AiExtractionOutput = z.infer<typeof aiExtractionOutputSchema>;

export const aiExtractionGenerateSchema = z.strictObject({
  notes: z.string().trim().min(10).max(10000),
});

// The confirm draft is validated again here because the client echoes
// it back; a tampered draft must fail validation rather than create
// bad tasks.
export const aiExtractionConfirmSchema = z.strictObject({
  draft: aiExtractionOutputSchema,
});

export const aiRiskOutputSchema = z.strictObject({
  risks: z
    .array(
      z.strictObject({
        title: z.string().trim().min(1).max(200),
        detail: z.string().trim().min(1).max(2000),
        severity: z.enum(["low", "medium", "high"]),
      }),
    )
    .max(30),
});

export type AiRiskOutput = z.infer<typeof aiRiskOutputSchema>;
