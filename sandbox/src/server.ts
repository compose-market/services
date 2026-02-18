/**
 * Sandbox Service HTTP API
 * 
 * Provides endpoints for Docker-isolated agent execution with:
 * - Full container isolation
 * - Memory integration (infinite memory)
 * - Backpack connector access
 * - Resource limits
 */
import "dotenv/config";
import express, { type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { PORTS, CONNECTOR_BASE_URL } from "../../shared/config.js";
import {
  handleX402Payment,
  extractPaymentInfo,
  DEFAULT_PRICES,
} from "../../shared/payment.js";
import { SandboxExecutionEngine, type SandboxExecutionParams, type SandboxExecutionResult } from "./sandbox-engine.js";
import { SandboxDockerManager, type ContainerInfo, type SandboxConfig } from "./docker-manager.js";
import { getOpenClawRuntimeManager } from "./openclaw-runtime.js";

const app = express();
app.use(express.json({ limit: "1mb" }));
const MANOWAR_INTERNAL_SECRET = process.env.MANOWAR_INTERNAL_SECRET || "";

// Request logging middleware
app.use((req: Request, _res: Response, next: NextFunction) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path}`);
  next();
});

// CORS is handled by Nginx reverse proxy - do not add headers here to avoid duplicates

// Async handler wrapper
function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

/**
 * Helper to extract string from route params (Express v5 types them as string | string[])
 */
function getParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] || "";
  return value || "";
}

function requireInternalAuth(req: Request, res: Response): boolean {
  if (!MANOWAR_INTERNAL_SECRET) {
    res.status(503).json({ error: "MANOWAR_INTERNAL_SECRET is not configured" });
    return false;
  }
  const internalHeader = req.headers["x-manowar-internal"];
  const provided = Array.isArray(internalHeader) ? internalHeader[0] : internalHeader;
  if (provided !== MANOWAR_INTERNAL_SECRET) {
    res.status(401).json({ error: "Unauthorized internal request" });
    return false;
  }
  return true;
}

// =============================================================================
// Zod Schemas for API Validation
// =============================================================================

const SandboxCreateSchema = z.object({
  sessionKey: z.string().min(1, "sessionKey is required"),
  agentWallet: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Invalid wallet address"),
  framework: z.enum(["langchain", "openclaw"]).default("openclaw"),
  workspaceDir: z.string().optional(),
  workspaceAccess: z.enum(["none", "ro", "rw"]).default("none"),
  networkAllow: z.array(z.string()).optional(),
  resourceLimits: z.object({
    memory: z.number().optional(),
    cpuShares: z.number().optional(),
    pidsLimit: z.number().optional(),
    timeoutMs: z.number().optional(),
  }).optional(),
});

const SandboxExecuteSchema = z.object({
  sessionKey: z.string().min(1, "sessionKey is required"),
  agentWallet: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Invalid wallet address"),
  framework: z.enum(["langchain", "openclaw"]).default("openclaw"),
  message: z.string().min(1, "message is required"),
  userId: z.string().optional(),
  grantedPermissions: z.array(z.string()).default([]),
  workspaceDir: z.string().optional(),
  workspaceAccess: z.enum(["none", "ro", "rw"]).default("none"),
  networkAllow: z.array(z.string()).optional(),
  resourceLimits: z.object({
    memory: z.number().optional(),
    cpuShares: z.number().optional(),
    pidsLimit: z.number().optional(),
    timeoutMs: z.number().optional(),
  }).optional(),
  conversationHistory: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string(),
  })).optional(),
});

const OpenClawEnsureSchema = z.object({
  agentWallet: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Invalid wallet address"),
  model: z.string().min(1, "model is required"),
  userKey: z.string().min(1, "userKey is required"),
  threadId: z.string().optional(),
  sessionKey: z.string().optional(),
});

const OpenClawChatSchema = z.object({
  agentWallet: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Invalid wallet address"),
  model: z.string().min(1, "model is required"),
  message: z.string().min(1, "message is required"),
  userKey: z.string().min(1, "userKey is required"),
  userId: z.string().optional(),
  threadId: z.string().optional(),
  manowarWallet: z.string().optional(),
  grantedPermissions: z.array(z.string()).default([]),
  sessionKey: z.string().optional(),
});

// =============================================================================
// Engine & Manager Instances
// =============================================================================

let engine: SandboxExecutionEngine | null = null;
let dockerManager: SandboxDockerManager | null = null;

function getEngine(): SandboxExecutionEngine {
  if (!engine) {
    engine = new SandboxExecutionEngine();
  }
  return engine;
}

function getDockerManager(): SandboxDockerManager {
  if (!dockerManager) {
    dockerManager = new SandboxDockerManager();
  }
  return dockerManager;
}

// =============================================================================
// Routes
// =============================================================================

/**
 * GET /health
 * Health check endpoint
 */
app.get("/health", async (_req: Request, res: Response) => {
  let dockerAvailable = false;
  try {
    await getDockerManager().listSandboxes();
    dockerAvailable = true;
  } catch {
    dockerAvailable = false;
  }
  
  res.json({
    status: "ok",
    service: "sandbox",
    version: "2.0.0",
    timestamp: new Date().toISOString(),
    connectorHub: CONNECTOR_BASE_URL,
    docker: dockerAvailable ? "connected" : "unavailable",
  });
});

/**
 * POST /sandbox/create
 * Create a new sandbox container
 */
app.post(
  "/sandbox/create",
  asyncHandler(async (req: Request, res: Response) => {
    const parseResult = SandboxCreateSchema.safeParse(req.body);
    
    if (!parseResult.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: parseResult.error.issues.map((e) => ({
          path: e.path.join("."),
          message: e.message
        }))
      });
      return;
    }
    
    const params = parseResult.data;
    
    const config: SandboxConfig = {
      sessionKey: params.sessionKey,
      agentWallet: params.agentWallet,
      framework: params.framework,
      workspaceDir: params.workspaceDir,
      workspaceAccess: params.workspaceAccess,
      networkAllow: params.networkAllow,
      resourceLimits: params.resourceLimits,
    };
    
    try {
      const containerName = await getDockerManager().createSandbox(config);
      
      res.status(201).json({
        success: true,
        containerName,
        sessionKey: params.sessionKey,
      });
    } catch (error) {
      res.status(500).json({
        error: "Failed to create sandbox",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  })
);

/**
 * POST /sandbox/execute
 * Execute an agent in a sandboxed environment
 */
app.post(
  "/sandbox/execute",
  asyncHandler(async (req: Request, res: Response) => {
    const paymentInfo = extractPaymentInfo(
      req.headers as Record<string, string | string[] | undefined>
    );

    const resourceUrl = `https://${req.get("host")}${req.originalUrl}`;
    const paymentResult = await handleX402Payment(
      paymentInfo.paymentData,
      resourceUrl,
      "POST",
      DEFAULT_PRICES.WORKFLOW_RUN,
      paymentInfo.chainId,
    );

    if (paymentResult.status !== 200) {
      Object.entries(paymentResult.responseHeaders).forEach(([key, value]) => {
        res.setHeader(key, value);
      });
      res.status(paymentResult.status).json(paymentResult.responseBody);
      return;
    }
    console.log(`[x402] Payment verified for sandbox/execute`);

    const parseResult = SandboxExecuteSchema.safeParse(req.body);

    if (!parseResult.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: parseResult.error.issues.map((e) => ({
          path: e.path.join("."),
          message: e.message
        }))
      });
      return;
    }

    const params = parseResult.data;
    
    const execParams: SandboxExecutionParams = {
      sessionKey: params.sessionKey,
      agentWallet: params.agentWallet,
      framework: params.framework,
      message: params.message,
      userId: params.userId,
      grantedPermissions: params.grantedPermissions,
      workspaceDir: params.workspaceDir,
      workspaceAccess: params.workspaceAccess,
      networkAllow: params.networkAllow,
      resourceLimits: params.resourceLimits,
      conversationHistory: params.conversationHistory,
    };

    const result = await getEngine().executeAgent(execParams);
    
    res.json({
      success: result.success,
      content: result.content,
      containerName: result.containerName,
      duration: result.duration,
      memoryStored: result.memoryStored,
      toolCalls: result.toolCalls,
    });
  })
);

/**
 * DELETE /sandbox/container/:name
 * Destroy a sandbox container
 */
app.delete(
  "/sandbox/container/:name",
  asyncHandler(async (req: Request, res: Response) => {
    const name = getParam(req.params.name);
    
    try {
      await getDockerManager().destroySandbox(name);
      res.json({ success: true, message: `Container ${name} destroyed` });
    } catch (error) {
      res.status(500).json({
        error: "Failed to destroy sandbox",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  })
);

/**
 * GET /sandbox/container/:name
 * Get sandbox container info
 */
app.get(
  "/sandbox/container/:name",
  asyncHandler(async (req: Request, res: Response) => {
    const name = getParam(req.params.name);
    const info = await getDockerManager().getContainerInfo(name);
    
    if (!info) {
      res.status(404).json({ error: `Container ${name} not found` });
      return;
    }
    
    res.json(info);
  })
);

/**
 * GET /sandbox/list
 * List all sandbox containers
 */
app.get(
  "/sandbox/list",
  asyncHandler(async (_req: Request, res: Response) => {
    const containers = await getDockerManager().listSandboxes();
    res.json({ count: containers.length, containers });
  })
);

/**
 * POST /sandbox/cleanup
 * Cleanup idle sandboxes
 */
app.post(
  "/sandbox/cleanup",
  asyncHandler(async (req: Request, res: Response) => {
    const maxAgeMs = typeof req.body.maxAgeMs === "number" 
      ? req.body.maxAgeMs 
      : 30 * 60 * 1000; // 30 min default
    
    const cleaned = await getDockerManager().cleanupIdleSandboxes(maxAgeMs);
    res.json({ success: true, cleaned });
  })
);

/**
 * GET /sandbox/connectors
 * Proxy to Connector Hub to list available connectors
 */
app.get(
  "/sandbox/connectors",
  asyncHandler(async (_req: Request, res: Response) => {
    try {
      const response = await fetch(`${CONNECTOR_BASE_URL}/connectors`);

      if (!response.ok) {
        res.status(response.status).json({
          error: "Failed to fetch connectors from Connector Hub",
          status: response.status
        });
        return;
      }

      const data = await response.json();
      res.json(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(503).json({
        error: "Connector Hub unavailable",
        message
      });
    }
  })
);

/**
 * GET /sandbox/connectors/:id/tools
 * Proxy to Connector Hub to list tools for a connector
 */
app.get(
  "/sandbox/connectors/:id/tools",
  asyncHandler(async (req: Request, res: Response) => {
    const id = getParam(req.params.id);

    try {
      const response = await fetch(
        `${CONNECTOR_BASE_URL}/connectors/${encodeURIComponent(id)}/tools`
      );

      if (!response.ok) {
        const text = await response.text();
        res.status(response.status).json({
          error: `Failed to fetch tools for connector "${id}"`,
          message: text
        });
        return;
      }

      const data = await response.json();
      res.json(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(503).json({
        error: "Connector Hub unavailable",
        message
      });
    }
  })
);

/**
 * POST /internal/openclaw/runtime/ensure
 * Internal endpoint used by Manowar to bootstrap/reuse per-user OpenClaw runtime containers.
 */
app.post(
  "/internal/openclaw/runtime/ensure",
  asyncHandler(async (req: Request, res: Response) => {
    if (!requireInternalAuth(req, res)) return;

    const parseResult = OpenClawEnsureSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: parseResult.error.issues.map((e) => ({
          path: e.path.join("."),
          message: e.message,
        })),
      });
      return;
    }

    const params = parseResult.data;
    const runtime = await getOpenClawRuntimeManager().ensureRuntime({
      agentWallet: params.agentWallet,
      model: params.model,
      userKey: params.userKey,
      sessionKey: params.sessionKey,
    });

    res.json({
      success: true,
      runtimeId: runtime.runtimeId,
      containerName: runtime.containerName,
      sessionKey: runtime.sessionKey,
      model: runtime.model,
    });
  })
);

/**
 * POST /internal/openclaw/chat
 * Internal endpoint for non-streaming OpenClaw chat.
 */
app.post(
  "/internal/openclaw/chat",
  asyncHandler(async (req: Request, res: Response) => {
    if (!requireInternalAuth(req, res)) return;

    const parseResult = OpenClawChatSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: parseResult.error.issues.map((e) => ({
          path: e.path.join("."),
          message: e.message,
        })),
      });
      return;
    }

    const params = parseResult.data;
    const payload = await getOpenClawRuntimeManager().chat({
      agentWallet: params.agentWallet,
      model: params.model,
      message: params.message,
      userKey: params.userKey,
      userId: params.userId,
      sessionKey: params.sessionKey,
    });

    res.json(payload);
  })
);

/**
 * POST /internal/openclaw/chat/stream
 * Internal endpoint for streaming OpenClaw chat (SSE passthrough).
 */
app.post(
  "/internal/openclaw/chat/stream",
  asyncHandler(async (req: Request, res: Response) => {
    if (!requireInternalAuth(req, res)) return;

    const parseResult = OpenClawChatSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: parseResult.error.issues.map((e) => ({
          path: e.path.join("."),
          message: e.message,
        })),
      });
      return;
    }

    const params = parseResult.data;
    const { runtime, response } = await getOpenClawRuntimeManager().streamChat({
      agentWallet: params.agentWallet,
      model: params.model,
      message: params.message,
      userKey: params.userKey,
      userId: params.userId,
      sessionKey: params.sessionKey,
    });

    const contentType = response.headers.get("content-type") || "text/event-stream";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("x-openclaw-runtime-id", runtime.runtimeId);
    res.setHeader("x-openclaw-container-name", runtime.containerName);

    const reader = response.body?.getReader();
    if (!reader) {
      res.status(502).json({ error: "OpenClaw stream missing response body" });
      return;
    }

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (res.writableEnded) {
        await reader.cancel();
        break;
      }
      if (value) {
        res.write(Buffer.from(value));
      }
    }

    if (!res.writableEnded) {
      res.end();
    }
  })
);

// =============================================================================
// Error Handler
// =============================================================================

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[error]", err);
  res.status(500).json({
    error: "Internal server error",
    message: err.message
  });
});

// =============================================================================
// Server Startup
// =============================================================================

const server = app.listen(PORTS.SANDBOX, "0.0.0.0", () => {
  console.log(`\n🧪 Sandbox Service v2.0 listening on http://0.0.0.0:${PORTS.SANDBOX}`);
  console.log(`   Connector Hub: ${CONNECTOR_BASE_URL}`);
  console.log("\nEndpoints:");
  console.log("  GET    /health                     - Health check");
  console.log("  POST   /sandbox/create             - Create sandbox container");
  console.log("  POST   /sandbox/execute            - Execute agent in sandbox (x402)");
  console.log("  GET    /sandbox/list               - List all sandboxes");
  console.log("  GET    /sandbox/container/:name    - Get sandbox info");
  console.log("  DELETE /sandbox/container/:name    - Destroy sandbox");
  console.log("  POST   /sandbox/cleanup            - Cleanup idle sandboxes");
  console.log("  GET    /sandbox/connectors         - List connectors (proxy)");
  console.log("  GET    /sandbox/connectors/:id/tools - List tools (proxy)");
  console.log("  POST   /internal/openclaw/runtime/ensure - Ensure OpenClaw runtime (internal)");
  console.log("  POST   /internal/openclaw/chat     - OpenClaw chat (internal)");
  console.log("  POST   /internal/openclaw/chat/stream - OpenClaw stream (internal)");
  console.log("");
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("\nReceived SIGTERM, shutting down gracefully...");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  console.log("\nReceived SIGINT, shutting down gracefully...");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});

export default app;
