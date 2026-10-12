import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const interrupted = (init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
  init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
});

beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("API request boundaries", () => {
  it("shares session initialization and attaches the recovered token", async () => {
    const fetch = vi.fn(async (url: string) => url === "/api/session" ? json({ token: "session" }) : json({ ok: true }));
    vi.stubGlobal("fetch", fetch);
    const { api } = await import("../src/api");
    await Promise.all([api("/health"), api("/projects")]);
    expect(fetch.mock.calls.filter(([url]) => url === "/api/session")).toHaveLength(1);
    expect((fetch.mock.calls[1] as unknown as [string, RequestInit])[1].headers).toMatchObject({ "X-Forma-Session": "session" });
  });

  it("bounds reads and aborts the actual fetch without retry", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn((url: string, init?: RequestInit) => url === "/api/session" ? Promise.resolve(json({ token: "session" })) : interrupted(init));
    vi.stubGlobal("fetch", fetch);
    const { api, ApiRequestError } = await import("../src/api");
    const result = api("/health", undefined, undefined, { timeoutMs: 25 }).catch(error => error);
    await vi.advanceTimersByTimeAsync(30);
    expect(await result).toBeInstanceOf(ApiRequestError);
    expect((await result).outcomeUnknown).toBe(false);
    expect((await result).message).toContain("超时");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][1]?.signal?.aborted).toBe(true);
  });

  it("keeps the deadline through response body decoding", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/session") return Promise.resolve(json({ token: "session" }));
      return Promise.resolve({ status: 200, ok: true, json: () => interrupted(init) } as unknown as Response);
    }));
    const { api } = await import("../src/api");
    const result = api("/health", undefined, undefined, { timeoutMs: 25 }).catch(error => error);
    await vi.advanceTimersByTimeAsync(30);
    expect((await result).message).toContain("超时");
  });

  it("reconciles a lost write response with a snapshot and never repeats the write", async () => {
    vi.useFakeTimers();
    const snapshot = { activeJob: { id: "accepted-job", projectId: "p" } };
    const fetch = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/session") return Promise.resolve(json({ token: "session" }));
      if (url === "/api/projects/p/scene") return Promise.resolve(json(snapshot));
      return interrupted(init);
    });
    vi.stubGlobal("fetch", fetch);
    const { api } = await import("../src/api");
    const result = api("/projects/p/generate", { prompt: "model" }, undefined, { timeoutMs: 25 }).catch(error => error);
    await vi.advanceTimersByTimeAsync(30);
    const error = await result;
    expect(error.outcomeUnknown).toBe(true);
    expect(error.reconciled).toBe(true);
    expect(error.reconciliation).toEqual(snapshot);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(["/api/session", "/api/projects/p/generate", "/api/projects/p/scene"]);
  });

  it("checks a retry's original owner before reading the project, without repeating AI", async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url === "/api/session") return json({ token: "session" });
      if (url === "/api/jobs/old/retry") throw new TypeError("connection lost");
      if (url === "/api/jobs/old") return json({ projectId: "p" });
      return json({ project: { id: "p" }, activeJob: { id: "accepted-job" } });
    });
    vi.stubGlobal("fetch", fetch);
    const { api } = await import("../src/api");
    const error = await api("/jobs/old/retry", {}).catch(error => error);
    expect(error.reconciled).toBe(true);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(["/api/session", "/api/jobs/old/retry", "/api/jobs/old", "/api/projects/p/scene"]);
  });

  it.each(["attachment", "video"])("recovers a %s upload's 401 session without replaying the bytes", async kind => {
    let session = 0;
    const fetch = vi.fn(async (url: string) => {
      if (url === "/api/session") return json({ token: `session-${++session}` });
      if (url === "/api/health") return json({ ok: true });
      return json({ error: "expired" }, 401);
    });
    vi.stubGlobal("fetch", fetch);
    const { api, uploadAttachment, uploadVideoFile } = await import("../src/api");
    const upload = kind === "attachment" ? uploadAttachment("p", new File(["image"], "photo.png")) : uploadVideoFile("p", "v", new Blob(["video"]));
    await expect(upload).rejects.toThrow("会话已失效");
    await api("/health");
    expect(session).toBe(2);
    expect(fetch.mock.calls.filter(([url]) => url.includes("attachments") || url.includes("/upload"))).toHaveLength(1);
    expect((fetch.mock.calls.at(-1) as unknown as [string, RequestInit])[1].headers).toMatchObject({ "X-Forma-Session": "session-2" });
  });

  it("does not reconcile a known validation rejection, but does reconcile a write 500", async () => {
    let status = 400;
    const fetch = vi.fn(async (url: string) => url === "/api/session" ? json({ token: "session" }) : url.endsWith("/scene") ? json({ project: { id: "p" } }) : json({ error: "failed" }, status));
    vi.stubGlobal("fetch", fetch);
    const { api } = await import("../src/api");
    const validation = await api("/projects/p/commands", {}).catch(error => error);
    expect(validation.outcomeUnknown).toBe(false);
    expect(fetch.mock.calls.some(([url]) => url.endsWith("/scene"))).toBe(false);
    status = 500;
    const uncertain = await api("/projects/p/commands", {}).catch(error => error);
    expect(uncertain.outcomeUnknown).toBe(true);
    expect(uncertain.reconciled).toBe(true);
  });

  it("surfaces malformed success JSON as uncertain for a write", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "/api/session" ? json({ token: "session" }) : url.endsWith("/scene") ? json({ project: { id: "p" } }) : new Response("<html>broken</html>")));
    const { api } = await import("../src/api");
    const error = await api("/projects/p/discuss", {}).catch(error => error);
    expect(error.outcomeUnknown).toBe(true);
    expect(error.reconciled).toBe(true);
    expect(error.message).toContain("无法读取");
  });

  it("honors caller cancellation before any request and reconciles cancellation after a write was sent", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = vi.fn((url: string, init?: RequestInit) => url === "/api/session" ? Promise.resolve(json({ token: "session" })) : url.endsWith("/scene") ? Promise.resolve(json({ project: { id: "p" } })) : interrupted(init));
    vi.stubGlobal("fetch", fetch);
    const { api, initSession } = await import("../src/api");
    await expect(api("/projects/p/discuss", {}, undefined, { signal: controller.signal })).rejects.toThrow("中止");
    expect(fetch).not.toHaveBeenCalled();
    await initSession();
    const running = new AbortController();
    const result = api("/projects/p/discuss", {}, undefined, { signal: running.signal }).catch(error => error);
    running.abort();
    const error = await result;
    expect(error.outcomeUnknown).toBe(true);
    expect(error.reconciled).toBe(true);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("rejects an unavailable session instead of recursing and leaves reconciliation failures actionable", async () => {
    let sessionError = true;
    const fetch = vi.fn(async (url: string) => {
      if (url === "/api/session") return sessionError ? json({}, 401) : json({ token: "session" });
      throw new TypeError("offline");
    });
    vi.stubGlobal("fetch", fetch);
    const { api } = await import("../src/api");
    await expect(api("/health")).rejects.toThrow("无法建立后台会话");
    expect(fetch).toHaveBeenCalledTimes(1);
    sessionError = false;
    const error = await api("/projects/p/discuss", {}).catch(error => error);
    expect(error.reconciled).toBe(false);
    expect(error.message).toContain("勿重复提交");
    expect(fetch.mock.calls.filter(([url]) => url === "/api/projects/p/discuss")).toHaveLength(1);
  });
});
