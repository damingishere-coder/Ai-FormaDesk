import { z } from "zod";
export const viewNames = ["front", "right", "top"] as const;
export const viewLabels: Record<string, string> = { front: "正面", right: "右侧", back: "背面", top: "顶部" };
export function referenceViews(prompt: string): string[] {
  return /(?:背面|背视|后视|背部).{0,15}(?:三视图|视图|参考)|(?:三视图|视图|正面|侧面).{0,30}(?:背面|背视|后视)/.test(prompt)
    ? ["front", "right", "back"] : [...viewNames];
}
export type ViewName = (typeof viewNames)[number];
export const subjectSchema = z.object({
  clear: z.boolean(),
  question: z.string(),
  subject: z.string(),
  parts: z.array(z.string()),
  proportions: z.string(),
  materials: z.string(),
  assumptions: z.array(z.string()),
});
export const visualReviewSchema = z.object({
  acceptable: z.boolean(),
  shapeIssues: z.array(z.string()),
  textureIssues: z.array(z.string()),
  lightingIssues: z.array(z.string()),
  repair: z.string(),
});
export type VisualReview = z.infer<typeof visualReviewSchema>;
export const surfaceSchema = z.object({
  lighting: z.object({
    viewTransform: z.enum(["Standard", "AgX"]),
    exposure: z.number().min(-2).max(2),
    worldStrength: z.number().min(0.05).max(2),
    key: z.number().min(0.25).max(2),
    fill: z.number().min(0.25).max(2),
    rim: z.number().min(0.25).max(2),
  }),
  objects: z.array(
    z.object({
      id: z.string().uuid(),
      kind: z.enum(["solid", "wood", "fabric", "image"]),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      roughness: z.number().min(0).max(1),
      metalness: z.number().min(0).max(1),
      description: z.string(),
    }),
  ),
});
export type SurfacePlan = z.infer<typeof surfaceSchema>;
export type VisualEvidence = {
  artifactId: string;
  label: string;
  kind: "image" | "report" | "model";
};
export type VisualJobState = {
  pipelineVersion?: 2;
  referenceViews?: string[];
  lastActivityAt?: string;
  activity?: string;
  steps?: { id: string; label: string; startedAt: string; endedAt?: string; status: "running" | "succeeded" | "failed" }[];
  runId: string;
  phase: string;
  assumptions: string[];
  evidence: VisualEvidence[];
  reviews: { phase: string; round: number; result: VisualReview }[];
};
