import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const paymentMock = vi.hoisted(() => ({
  handleX402Payment: vi.fn(),
  extractPaymentInfo: vi.fn(() => ({ paymentData: "sig", chainId: 338 })),
  DEFAULT_PRICES: {
    MCP_TOOL_CALL: "1000",
    GOAT_EXECUTE: "1000",
    ELIZA_ACTION: "1000",
  },
}));

const registryMock = vi.hoisted(() => ({
  createRegistryRouter: vi.fn(() => ((_: unknown, __: unknown, next: () => void) => next())),
  getServerByRegistryId: vi.fn(async () => null),
  getRegistry: vi.fn(async () => []),
  getServerSpawnConfig: vi.fn(async () => null),
}));

const builderMock = vi.hoisted(() => ({
  buildAgentCardFromRegistry: vi.fn(() => ({ id: "card" })),
}));

const validateMock = vi.hoisted(() => ({
  validateAgentCard: vi.fn(() => ({ ok: true })),
  assertValidAgentCard: vi.fn((card: unknown) => card),
}));

vi.mock("../../shared/payment.js", () => paymentMock);
vi.mock("../src/registry.js", () => ({
  createRegistryRouter: registryMock.createRegistryRouter,
  getServerByRegistryId: registryMock.getServerByRegistryId,
  getRegistry: registryMock.getRegistry,
  getServerSpawnConfig: registryMock.getServerSpawnConfig,
}));
vi.mock("../src/builder.js", () => builderMock);
vi.mock("../src/validate.js", () => validateMock);

import app, { __resetRuntimeCircuitStateForTests } from "../src/server.js";

function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  } as Response;
}

describe("connector server", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetRuntimeCircuitStateForTests();
    vi.stubGlobal("fetch", vi.fn());

    paymentMock.handleX402Payment.mockResolvedValue({
      status: 200,
      responseBody: { ok: true },
      responseHeaders: {},
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns health status", async () => {
    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
    expect(response.body.service).toBe("connector-hub");
  });

  it("proxies /mcp/status to runtime", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, {
      status: "ok",
      runtimes: { mcp: true },
    }));

    const response = await request(app).get("/mcp/status");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok", runtimes: { mcp: true } });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("retries transient runtime failures and succeeds", async () => {
    const timerSpy = vi.spyOn(global, "setTimeout").mockImplementation((fn: any) => {
      fn();
      return 0 as any;
    });

    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(503, { error: "temporary" }))
      .mockResolvedValueOnce(jsonResponse(503, { error: "temporary" }))
      .mockResolvedValueOnce(jsonResponse(200, { status: "ok" }));

    const response = await request(app).get("/mcp/status");

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);

    timerSpy.mockRestore();
  });

  it("opens circuit after repeated upstream failures", async () => {
    const timerSpy = vi.spyOn(global, "setTimeout").mockImplementation((fn: any) => {
      fn();
      return 0 as any;
    });

    vi.mocked(fetch).mockRejectedValue(new Error("runtime down"));

    const first = await request(app).get("/mcp/status");
    const second = await request(app).get("/mcp/status");
    const third = await request(app).get("/mcp/status");

    expect(first.status).toBe(503);
    expect(second.status).toBe(503);
    expect(third.status).toBe(503);
    expect(third.body.message).toContain("circuit is open");

    // First two requests exhaust retries (4 each); third should short-circuit without fetch.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(8);

    timerSpy.mockRestore();
  });

  it("forwards /mcp/servers/:slug/tools response and status", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(404, {
      error: "not found",
      available: [],
    }));

    const response = await request(app).get("/mcp/servers/github/tools");

    expect(response.status).toBe(404);
    expect(response.body.error).toBe("not found");
  });

  it("validates /mcp/servers/:slug/call request body", async () => {
    const response = await request(app)
      .post("/mcp/servers/github/call")
      .send({ tool: "", args: {} });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("Invalid request body");
  });

  it("returns payment challenge when x402 verification fails", async () => {
    paymentMock.handleX402Payment.mockResolvedValueOnce({
      status: 402,
      responseBody: { error: "payment required" },
      responseHeaders: { "PAYMENT-RESPONSE": "challenge" },
    });

    const response = await request(app)
      .post("/mcp/servers/github/call")
      .send({ tool: "search", args: { q: "temporal" } });

    expect(response.status).toBe(402);
    expect(response.body).toEqual({ error: "payment required" });
    expect(response.headers["payment-response"]).toBe("challenge");
  });

  it("forwards correlation headers on tool calls", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, {
      success: true,
      result: { ok: true },
    }));

    const response = await request(app)
      .post("/mcp/servers/github/call")
      .set("x-manowar-internal", "secret-token")
      .set("x-compose-run-id", "run-123")
      .set("x-idempotency-key", "idem-123")
      .send({ tool: "search", args: { q: "compose" } });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/mcp/servers/github/tools/search");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["x-manowar-internal"]).toBe("secret-token");
    expect((init.headers as Record<string, string>)["x-compose-run-id"]).toBe("run-123");
    expect((init.headers as Record<string, string>)["x-idempotency-key"]).toBe("idem-123");
  });
});
