import type { Project } from "../src/types";
import { get, list, now, put } from "./store";

type ThreadUsage = {
  id: string;
  projectId: string;
  totalTokens: number | null;
};

export function startTokenTracking() {
  const previous = get<{ id: string; startedAt: string }>("token-tracking", "start");
  if (previous) return previous.startedAt;
  const startedAt = now();
  put("token-tracking", { id: "start", startedAt });
  return startedAt;
}

export function bindTokenThread(projectId: string | undefined, threadId: string) {
  if (!projectId || !threadId || !get<Project>("project", projectId)) return;
  const previous = get<ThreadUsage>("token-usage", threadId);
  if (previous) {
    if (previous.projectId !== projectId) throw new Error("Codex 用量会话不属于此作品");
    return;
  }
  put("token-usage", { id: threadId, projectId, totalTokens: null });
}

/** The API total already includes cached input and reasoning. Never add them again. */
export function recordTokenTotal(threadId: string, totalTokens: unknown) {
  if (typeof totalTokens !== "number" || !Number.isSafeInteger(totalTokens) || totalTokens < 0) return;
  const previous = get<ThreadUsage>("token-usage", threadId);
  if (!previous || (previous.totalTokens !== null && totalTokens <= previous.totalTokens)) return;
  // Store the high-water mark: duplicates, resumed sessions and history imports are idempotent.
  put("token-usage", { ...previous, totalTokens });
}

export function observeTokenUsage(message: any) {
  if (message.method !== "thread/tokenUsage/updated") return;
  recordTokenTotal(message.params?.threadId, message.params?.tokenUsage?.total?.totalTokens);
}

export function projectTokenUsage(project: Project): Project["tokenUsage"] {
  const startedAt = get<{ startedAt: string }>("token-tracking", "start")?.startedAt;
  const entries = list<ThreadUsage>("token-usage", project.id);
  const known = entries.filter((entry) => entry.totalTokens !== null);
  const trackedFromCreation = !!startedAt && Date.parse(project.createdAt) >= Date.parse(startedAt);
  if (!known.length && (!trackedFromCreation || entries.length)) return null;
  return {
    totalTokens: known.reduce((sum, entry) => sum + entry.totalTokens!, 0),
    partial: !trackedFromCreation || known.length !== entries.length,
  };
}
