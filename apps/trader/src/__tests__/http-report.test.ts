import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { startHttpServer } from "../http-server.js";

const mock = vi.hoisted(() => ({ handle: undefined as ((req: IncomingMessage, res: ServerResponse) => void) | undefined }));
vi.mock("node:http", () => ({
  createServer: vi.fn((handle) => {
    mock.handle = handle;
    return { listen: vi.fn(), close: vi.fn() };
  }),
}));

/** No sockets, server processes or live endpoints: exercise the captured handler only. */
function request(getReport?: () => unknown | Promise<unknown>) {
  const log = { info: vi.fn(), error: vi.fn() };
  const opts = {
    port: 0, host: "127.0.0.1", logger: log,
    emergency: {}, getStatus: vi.fn(), getMetrics: () => ({}),
    ...(getReport ? { getReport } : {}),
  } as unknown as Parameters<typeof startHttpServer>[0];
  startHttpServer(opts);
  let finish!: (value: unknown) => void;
  const body = new Promise((resolve) => { finish = resolve; });
  const response = {
    headersSent: false,
    writeHead: vi.fn(),
    end: vi.fn((value: string) => finish(JSON.parse(value))),
  };
  mock.handle!({ method: "GET", url: "/report", headers: {} } as IncomingMessage, response as unknown as ServerResponse);
  return { body, response, log };
}

describe("GET /report callback", () => {
  it("awaits the read-only report source instead of serializing a Promise as {}", async () => {
    let resolve!: (value: unknown) => void;
    const pending = new Promise((done) => { resolve = done; });
    const { body, response } = request(() => pending);
    expect(response.end).not.toHaveBeenCalled();
    resolve({ date: "2026-09-24", netPnlUsd: -0.090325 });
    await expect(body).resolves.toEqual({ date: "2026-09-24", netPnlUsd: -0.090325 });
    expect(response.writeHead).toHaveBeenCalledWith(200, { "content-type": "application/json" });
  });

  it("retains synchronous report callbacks", async () => {
    await expect(request(() => ({ date: "2026-09-24" })).body).resolves.toEqual({ date: "2026-09-24" });
  });

  it("returns an explicit HTTP error when a durable read fails, not an empty success", async () => {
    const { body, response, log } = request(async () => { throw new Error("fixture source unavailable"); });
    await expect(body).resolves.toEqual({ error: "internal error" });
    expect(response.writeHead).toHaveBeenCalledWith(500, { "content-type": "application/json" });
    expect(log.error).toHaveBeenCalled();
  });

  it("retains the disabled endpoint response", async () => {
    const { body, response } = request();
    await expect(body).resolves.toEqual({ error: "reporting not enabled" });
    expect(response.writeHead).toHaveBeenCalledWith(404, { "content-type": "application/json" });
  });
});
