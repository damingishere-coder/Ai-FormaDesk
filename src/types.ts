import { z } from "zod";
export const vec3 = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
]);
export const transformSchema = z.object({
  position: vec3,
  rotation: vec3,
  scale: vec3,
});
export const materialSchema = z.object({
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  roughness: z.number().min(0).max(1),
  metalness: z.number().min(0).max(1),
});
export const objectSchema = z.object({
  id: z.string().uuid(),
  name: z.string().max(256),
  type: z.enum([
    "MESH",
    "EMPTY",
    "LIGHT",
    "CAMERA",
    "CURVE",
    "FONT",
    "SURFACE",
    "META",
  ]),
  parentId: z.string().uuid().nullable(),
  transform: transformSchema,
  matrix: z.array(z.number().finite()).length(16),
  visible: z.boolean(),
  material: materialSchema.nullable(),
  light: z
    .object({
      type: z.enum(["POINT", "SUN"]),
      color: z.string(),
      energy: z.number().finite().min(0),
    })
    .nullable(),
});
export const sceneSchema = z
  .object({
    objects: z.array(objectSchema).max(1500),
    stats: z.object({
      objects: z.number().int().min(0),
      vertices: z.number().int().min(0),
      triangles: z.number().int().min(0),
    }),
    units: z.literal("meters"),
    coordinates: z.literal("blender-z-up"),
  })
  .superRefine((s, c) => {
    const ids = new Set(s.objects.map((o) => o.id));
    if (ids.size !== s.objects.length)
      c.addIssue({ code: "custom", message: "重复对象 ID" });
    for (const o of s.objects)
      if (o.parentId && !ids.has(o.parentId))
        c.addIssue({ code: "custom", message: "父对象不存在" });
  });
export const commandSchema = z
  .object({
    baseRevisionId: z.string().uuid(),
    objectId: z.string().uuid(),
    operation: z.enum([
      "transform",
      "material",
      "light",
      "duplicate",
      "delete",
      "visibility",
      "rename",
    ]),
    transform: transformSchema.optional(),
    material: materialSchema.optional(),
    light: z
      .object({
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        energy: z.number().min(0).max(1e6),
      })
      .optional(),
    visible: z.boolean().optional(),
    name: z.string().min(1).max(120).optional(),
  })
  .superRefine((v, c) => {
    const field = (
      {
        transform: "transform",
        material: "material",
        light: "light",
        visibility: "visible",
        rename: "name",
      } as const
    )[v.operation as "transform"];
    if (field && v[field] === undefined)
      c.addIssue({ code: "custom", message: `缺少 ${field}` });
    if (
      v.transform &&
      v.transform.scale.some((n) => Math.abs(n) < 0.001 || Math.abs(n) > 1000)
    )
      c.addIssue({ code: "custom", message: "缩放必须在 0.001～1000 范围内" });
  });
export const cameraSchema = z
  .object({
    position: vec3,
    target: vec3,
    up: vec3,
    fov: z.number().min(5).max(150),
    aspect: z
      .number()
      .min(1 / 16)
      .max(16),
  })
  .refine(
    (v) => v.position.some((n, i) => Math.abs(n - v.target[i]) > 1e-6),
    "相机位置不能与目标重合",
  );
export type SceneObject = z.infer<typeof objectSchema>;
export type Scene = z.infer<typeof sceneSchema>;
export type SceneCommand = z.infer<typeof commandSchema>;
export type CameraSpec = z.infer<typeof cameraSchema>;
export type Project = {
  id: string;
  name: string;
  currentRevisionId: string | null;
  threadId: string | null;
  createdAt: string;
  redo: string[];
  discussionThreadId?: string | null;
  updatedAt?: string;
  deletedAt?: string | null;
  cleanupState?: "pending" | "failed" | null;
  coverUrl?: string | null;
  activeJob?: Job | null;
};
export type Revision = {
  id: string;
  projectId: string;
  parentId: string | null;
  source: string;
  label: string;
  createdAt: string;
  scene: Scene;
  artifacts: {
    blend: string;
    glb: string;
    script: string;
    manifest: string;
    log: string;
  };
};
export type Job = {
  id: string;
  projectId: string;
  baseRevisionId: string | null;
  type: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  stage: string;
  error: string | null;
  resultRevisionId: string | null;
  createdAt: string;
  updatedAt: string;
  message: string;
  renderArtifactId?: string;
  title?: string;
  stageIndex?: number;
  attempt?: number;
  estimate?: { low: number; high: number; source: "initial" | "history" };
  progress?: { completed: number; total: number; remainingSeconds?: number };
  events?: {
    stage: string;
    at: string;
    endedAt?: string;
    index?: number;
    attempt?: number;
    error?: string;
  }[];
};
export type Render = {
  id: string;
  projectId: string;
  revisionId: string;
  artifactId: string;
  camera: CameraSpec;
  createdAt: string;
  settings?: RenderSettings;
};
export const renderSettingsSchema = z.object({
  width: z.number().int().min(256).max(4096).default(1280),
  height: z.number().int().min(256).max(4096).default(720),
  transparent: z.boolean().default(false),
});
export type RenderSettings = z.infer<typeof renderSettingsSchema>;
export const defaultRenderSettings: RenderSettings = {
  width: 1280,
  height: 720,
  transparent: false,
};
export type Attachment = {
  id: string;
  projectId: string;
  name: string;
  size: number;
  width: number;
  height: number;
  createdAt: string;
  used: boolean;
};
export type Proposal = {
  id: string;
  projectId: string;
  baseRevisionId: string | null;
  objectId: string | null;
  title: string;
  description: string;
  attachmentIds: string[];
  status: "ready" | "stale" | "running" | "succeeded" | "failed";
  jobId?: string;
  createdAt: string;
};
export type Message = {
  id: string;
  projectId: string;
  role: string;
  text: string;
  createdAt: string;
  attachmentIds?: string[];
  proposalId?: string;
  jobId?: string;
  status?: "pending" | "completed" | "failed" | "cancelled";
};
export type Snapshot = {
  project: Project;
  revision: Revision | null;
  scene: Scene;
  previewUrl: string | null;
  activeJob: Job | null;
  jobs?: Job[];
  videos?: VideoRecord[];
  render: Render | null;
  messages: Message[];
  proposals: Proposal[];
};

export const videoSettingsSchema = z.object({
  width: z
    .number()
    .int()
    .min(256)
    .max(1920)
    .refine((n) => n % 2 === 0),
  height: z
    .number()
    .int()
    .min(256)
    .max(1920)
    .refine((n) => n % 2 === 0),
  fps: z.literal(30),
  mode: z.enum(["realtime", "blender"]),
});
export type VideoSettings = z.infer<typeof videoSettingsSchema>;
export const trajectorySchema = z
  .object({
    baseRevisionId: z.string().uuid(),
    settings: videoSettingsSchema,
    samples: z
      .array(
        z.object({
          time: z.number().finite().min(0).max(60),
          camera: cameraSchema,
        }),
      )
      .min(2)
      .max(3602),
  })
  .superRefine((v, c) => {
    for (const { camera } of v.samples) {
      const d = camera.position.map((n, i) => n - camera.target[i]),
        u = camera.up;
      const cross = [
        d[1] * u[2] - d[2] * u[1],
        d[2] * u[0] - d[0] * u[2],
        d[0] * u[1] - d[1] * u[0],
      ];
      if (
        cross.reduce((n, x) => n + x * x, 0) < 1e-12 ||
        [...camera.position, ...camera.target, ...u].some(
          (n) => Math.abs(n) > 1e6,
        )
      )
        c.addIssue({ code: "custom", message: "相机坐标或朝向无效" });
    }
    if (
      v.samples[0].time !== 0 ||
      v.samples.at(-1)!.time < 0.1 ||
      v.samples.some((s, i) => i > 0 && s.time <= v.samples[i - 1].time)
    )
      c.addIssue({ code: "custom", message: "镜头时间必须从零开始并严格递增" });
  });
export type Trajectory = z.infer<typeof trajectorySchema>;
export type VideoRecord = {
  id: string;
  projectId: string;
  revisionId: string;
  settings: VideoSettings;
  createdAt: string;
  duration: number;
  artifactId?: string;
  mime?: string;
  status: "recorded" | "ready";
  trajectory: Trajectory;
};
