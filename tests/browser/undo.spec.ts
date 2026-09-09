import { test, expect } from "@playwright/test";
import type { Snapshot, Revision } from "../../src/types";

test("撤销直接回到上一步，支持连续撤销和重做；历史列表单独打开", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1195, height: 762 });
  const scene: Snapshot["scene"] = {
    objects: [], stats: { objects: 0, vertices: 0, triangles: 0 },
    units: "meters", coordinates: "blender-z-up",
  };
  const revisions = ["first", "second"].map((id, index): Revision => ({
    id, projectId: "undo-test", parentId: index ? "first" : null,
    source: "command", label: index ? "第二步" : "第一步",
    createdAt: "2026-09-07T09:00:00Z", scene,
    artifacts: { blend: "", glb: "", script: "", manifest: "", log: "" },
  }));
  const snapshot: Snapshot = {
    project: { id: "undo-test", name: "撤销交互测试", currentRevisionId: "second",
      threadId: null, createdAt: "2026-09-07T09:00:00Z", redo: [] },
    revision: revisions[1], scene, previewUrl: null, activeJob: null,
    render: null, messages: [], proposals: [],
  };
  const actions: { action: string; baseRevisionId: string | null; revisionId?: string }[] = [];
  let historyReads = 0;
  let rejectNext = false;
  await page.addInitScript(() => localStorage.setItem("forma-project", "undo-test"));
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url()).pathname;
    let json: unknown;
    if (url === "/api/session") json = { token: "test-session" };
    else if (url === "/api/blender/status") json = { installed: false, connected: false, state: "closed" };
    else if (url === "/api/health") json = { ok: true, codex: { ok: true } };
    else if (url === "/api/projects") json = [snapshot.project];
    else if (url.endsWith("/scene")) json = snapshot;
    else if (url.endsWith("/revisions")) { historyReads++; json = revisions; }
    else if (url.endsWith("/restore")) {
      const body = route.request().postDataJSON();
      actions.push(body);
      expect(body.baseRevisionId).toBe(snapshot.project.currentRevisionId);
      if (rejectNext) {
        rejectNext = false;
        await route.fulfill({ status: 409, json: { error: "版本已变化，请重试" } });
        return;
      }
      if (body.action === "undo") {
        snapshot.project.redo.push(snapshot.project.currentRevisionId!);
        snapshot.project.currentRevisionId = snapshot.revision!.parentId;
      } else if (body.action === "redo") {
        snapshot.project.currentRevisionId = snapshot.project.redo.pop()!;
      } else {
        snapshot.project.currentRevisionId = body.revisionId;
        snapshot.project.redo = [];
      }
      snapshot.revision = revisions.find(r => r.id === snapshot.project.currentRevisionId) || null;
      json = snapshot.project;
    } else throw new Error(`Unexpected API request: ${url}`);
    await route.fulfill({ json });
  });
  await page.goto("/");
  const undo = page.getByRole("button", { name: "撤销", exact: true });
  const redo = page.getByRole("button", { name: "重做", exact: true });
  const dialog = page.getByRole("dialog", { name: "版本历史", exact: true });
  await expect(page.getByRole("group", { name: "撤销与重做" })).toBeVisible();
  await expect(undo).toHaveText("");
  await expect(redo).toHaveText("");
  await expect(page.locator(".bottom-left").getByRole("button", { name: /撤销/ })).toHaveCount(0);
  await undo.click();
  await expect(page.getByRole("status")).toHaveText(/已撤销上一步/);
  await expect(dialog).toHaveCount(0);
  expect(actions).toEqual([{ action: "undo", baseRevisionId: "second" }]);
  expect(historyReads).toBe(0);
  await undo.click();
  await expect(undo).toBeDisabled();
  await expect(redo).toBeEnabled();
  expect(actions[1]).toEqual({ action: "undo", baseRevisionId: "first" });
  await redo.click();
  await expect(page.getByRole("status")).toHaveText(/已重做一步/);
  await expect(undo).toBeEnabled();
  expect(actions[2]).toEqual({ action: "redo", baseRevisionId: null });
  rejectNext = true;
  await undo.click();
  await expect(page.getByRole("alert")).toContainText("版本已变化，请重试");
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect(undo).toBeDisabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "版本历史", exact: true }).click();
  await expect(dialog).toBeVisible();
  expect(historyReads).toBe(1);
  await dialog.getByRole("button", { name: "恢复", exact: true }).first().click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveText(/已恢复所选版本/);
  await expect(undo).toBeEnabled();
  await expect(redo).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath("undo-workbench.png") });
});
