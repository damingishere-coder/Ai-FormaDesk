import { test as base, expect, type Route } from "@playwright/test";

/** All default browser specs import this fixture; no real DATA/backend exists. */
export const test = base.extend<{ _mockNetworkGuard: void }>({
  _mockNetworkGuard: [async ({ context, baseURL }, use) => {
    if (!baseURL) throw new Error("安全浏览器测试必须配置独立 baseURL");
    const origin = new URL(baseURL).origin;
    const violations: string[] = [];
    const reject = async (route: Route, reason: string) => {
      violations.push(reason);
      await route.abort("blockedbyclient");
      throw new Error(`浏览器 mock 边界拒绝：${reason}`);
    };
    await context.route("**/*", async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin)
        return reject(route, `外部请求 ${request.method()} ${url.origin}${url.pathname}`);
      if (!/^\/api(?:\/|$)/.test(url.pathname)) return route.continue();
      // Shared, explicit read-only contracts; a spec may override any of these
      // to test failure. Unknown paths/methods never get a generic {} response.
      if (request.method() === "GET") {
        if (url.pathname === "/api/session")
          return route.fulfill({ json: { token: "mock-session" } });
        if (url.pathname === "/api/health")
          return route.fulfill({ json: { ok: true, codex: { ok: true }, blender: { ok: true }, sandbox: { ok: true } } });
        if (url.pathname === "/api/blender/status")
          return route.fulfill({ json: { installed: false, connected: false, state: "closed" } });
      }
      return reject(route, `未 mock 的 API ${request.method()} ${url.pathname}`);
    });
    context.on("response", response => {
      if (response.headers()["x-forma-mock-guard"] === "unmocked-api")
        violations.push(`绕过 mock 的 API ${new URL(response.url()).pathname}`);
    });
    // APIRequestContext bypasses page/context routes; block that separate path.
    context.request.fetch = async () => {
      const reason = "安全 mock spec 不得使用 page.request/context.request 访问后台";
      violations.push(reason);
      throw new Error(reason);
    };
    await use();
    expect(violations, "所有 API 必须由明确 mock 契约处理").toEqual([]);
  }, { auto: true }],
  request: async () => {
    throw new Error("安全 mock spec 不得使用独立 request fixture 访问后台");
  },
});
export { expect };
