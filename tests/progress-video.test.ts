import { describe, it, expect } from "vitest";
import { estimateJob, etaText, stageIndex, connectionText } from "../src/progress";
import { trajectorySchema } from "../src/types";
import type { Job } from "../src/types";
const job = (
  id: string,
  duration: number,
  status: Job["status"] = "succeeded",
): Job => ({
  id,
  projectId: "p",
  baseRevisionId: null,
  type: "generate",
  status,
  stage: "完成",
  stageIndex: 5,
  error: null,
  resultRevisionId: null,
  message: "",
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(duration * 1000).toISOString(),
  events: [
    { stage: "生成脚本", index: 1, at: new Date(0).toISOString() },
    { stage: "执行建模", index: 2, at: new Date(50000).toISOString() },
  ],
});
describe("真实进度与轨迹边界", () => {
  it("终态优先于断线提示，细节失败说明模型仍保留", () => {
    const failed = { ...job("failed", 120, "failed"), type: "preview", stage: "模型已保存，预览细节未完成" };
    expect(connectionText(failed, true, Date.now())).toBe(failed.stage);
    expect(connectionText({ ...failed, status: "running" }, true, Date.now())).toContain("正在重新连接");
    expect(stageIndex("校验文件与生成基础预览")).toBe(3);
  });
  it("排除失败和取消样本，样本不足保持参考范围", () => {
    expect(
      estimateJob({ ...job("active", 0), stageIndex: 1 }, [
        job("1", 10),
        job("2", 20),
        job("3", 30),
        job("4", 40),
        job("5", 6000, "failed"),
      ]).source,
    ).toBe("initial");
  });
  it("按当前阶段和最近有效历史估算，不使用固定假进度", () => {
    const active = { ...job("active", 0), stageIndex: 2 };
    const estimate = estimateJob(
      active,
      Array.from({ length: 6 }, (_, i) => job(String(i), 100 + i * 10)),
    );
    expect(estimate.source).toBe("history");
    expect(estimate.low).toBe(60);
    expect(estimate.high).toBe(90);
  });
  it("超过上限不会倒数到负值，失败保持真实环节", () => {
    const j = {
      ...job("active", 0),
      status: "running" as const,
      estimate: { low: 120, high: 300, source: "initial" as const },
    };
    expect(etaText(j, 301000)).toContain("比预计耗时更久");
    expect(stageIndex("修复脚本（1/2）")).toBe(1);
  });
  it("拒绝无效尺寸、重复时间、超时、零长度及退化相机", () => {
    const camera = {
      position: [3, 2, 3],
      target: [0, 0, 0],
      up: [0, 1, 0],
      fov: 42,
      aspect: 16 / 9,
    };
    const v = {
      baseRevisionId: "00000000-0000-4000-8000-000000000001",
      settings: { width: 1280, height: 720, fps: 30, mode: "blender" },
      samples: [
        { time: 0, camera },
        { time: 1, camera },
      ],
    };
    expect(trajectorySchema.safeParse(v).success).toBe(true);
    expect(
      trajectorySchema.safeParse({
        ...v,
        settings: { ...v.settings, width: 1279 },
      }).success,
    ).toBe(false);
    for (const time of [0, 61, -1])
      expect(
        trajectorySchema.safeParse({
          ...v,
          samples: [v.samples[0], { time, camera }],
        }).success,
      ).toBe(false);
    expect(
      trajectorySchema.safeParse({
        ...v,
        samples: [
          { time: 0, camera: { ...camera, position: [0, 0, 0] } },
          v.samples[1],
        ],
      }).success,
    ).toBe(false);
  });
});
