/**
 * Connector Hub Server
 *
 * Handles metadata, registry, and routing for MCP servers.
 * Execution/spawning is delegated to the MCP Server (mcp.compose.market).
 *
 * Responsibilities:
 * - Registry: Unified view of all MCP servers, GOAT plugins, ElizaOS plugins
 * - Metadata: Server info, tools, categories, tags
 * - Routing: Proxies execution requests to MCP server
 * - Card Generation: Convert registry entries to ComposeAgentCard format
 *
 * NO EXECUTION HERE - All execution is proxied to MCP server.
 */
import "dotenv/config";
import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import { z } from "zod";
import { createRegistryRouter, getServerByRegistryId } from "./registry.js";
import { buildAgentCardFromRegistry } from "./builder.js";
import { validateAgentCard, assertValidAgentCard } from "./validate.js";
import type { UnifiedServerRecord } from "./registry.js";
import {
  handleX402Payment,
  extractPaymentInfo,
  DEFAULT_PRICES,
} from "../../shared/payment.js";

const app = express();

// CORS Configuration with wildcard subdomain support and proper preflight handling
const corsOptions = {
  origin: function (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) {
    // Allow requests with no origin (mobile apps, Postman, curl, server-to-server)
    if (!origin) return callback(null, true);

    // Define allowed origin patterns
    const allowedOrigins = [
      'http://localhost:5173',           // Local dev (Vite)
      'http://localhost:3000',           // Alternative local dev port
      'https://compose.market',          // Production root
      'https://www.compose.market',      // Production www
    ];

    // Check exact matches first
    if (allowedOrigins.indexOf(origin) !== -1) {
      return callback(null, true);
    }

    // Check wildcard patterns
    const wildcardPatterns = [
      /^https:\/\/[\w-]+\.compose\.market$/,  // https://*.compose.market (any subdomain)
      /^https:\/\/www\.[\w-]+\.compose\.market$/,  // https://www.*.compose.market
    ];

    for (const pattern of wildcardPatterns) {
      if (pattern.test(origin)) {
        return callback(null, true);
      }
    }

    // Origin not allowed
    console.warn(`[CORS] Blocked origin: ${origin}`);
    callback(new Error(`Origin ${origin} not allowed by CORS`));
  },
  credentials: true,                     // Allow cookies and credentials
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Payment',                         // x402 core payment header
    'X-Payment-Data',                    // x402 payment data
    'X-Payment-Signature',               // x402 signature
    'X-Payment-Timestamp',               // x402 timestamp
    'X-Requested-With',
    'x-session-active',                  // Session management
    'x-session-budget-remaining',        // Session budget
    'access-control-expose-headers',     // CORS header passthrough (thirdweb quirk)
  ],
  exposedHeaders: [
    'X-Payment-Required',                // x402 challenge header
    'X-Payment-Challenge',               // x402 challenge data
  ],
  maxAge: 86400,                        // Cache preflight for 24 hours (in seconds)
};

app.use(cors(corsOptions));
app.use(express.json());

// Mount the MCP registry router
app.use("/registry", createRegistryRouter());

// =============================================================================
// Configuration
// =============================================================================

/** MCP Server URL - where ALL execution happens */
const MCP_SERVER_URL = process.env.MCP_SERVICE_URL || "https://mcp.compose.market";

// =============================================================================
// Middleware
// =============================================================================

// Request logging middleware
app.use((req: Request, _res: Response, next: NextFunction) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path}`);
  next();
});

// Error handling wrapper
function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

// =============================================================================
// Health Check
// =============================================================================

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    service: "connector-hub",
    version: "0.3.0",
    mcpServer: MCP_SERVER_URL,
  });
});

/**
 * GET /registry/servers/:id/spawn
 * Get spawn configuration for an MCP server
 */
app.get(
  "/registry/servers/:id/spawn",
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;

    const { getServerSpawnConfig } = await import("./registry.js");
    const config = await getServerSpawnConfig(id);

    if (!config) {
      res.status(404).json({
        error: `Server ${id} is not installed or configured for spawning`,
        hint: "Only pre-installed servers can be spawned in production"
      });
      return;
    }

    res.json(config);
  })
);

// =============================================================================
// MCP Server Proxy Routes
// =============================================================================

/**
 * GET /mcp/servers
 * List spawnable MCP servers from local registry
 */
app.get(
  "/mcp/servers",
  asyncHandler(async (_req: Request, res: Response) => {
    // Get MCP servers from local registry, not from MCP server (circular dependency!)
    const { getRegistry } = await import("./registry.js");
    const registry = await getRegistry();

    // Filter for MCP servers only
    const mcpServers = registry.filter((s: UnifiedServerRecord) => s.origin === 'mcp');

    res.json({
      servers: mcpServers.map((s: UnifiedServerRecord) => ({
        id: s.registryId,
        slug: s.slug,
        name: s.name,
        description: s.description,
        category: s.category,
        tags: s.tags,
        origin: s.origin,
        executable: s.executable,
      })),
      total: mcpServers.length,
    });
  })
);

/**
 * GET /mcp/status
 * Proxy to MCP server - get spawned server status
 */
app.get(
  "/mcp/status",
  asyncHandler(async (_req: Request, res: Response) => {
    try {
      const response = await fetch(`${MCP_SERVER_URL}/status`);
      const data = await response.json();
      res.json(data);
    } catch (error) {
      res.status(503).json({
        error: "MCP server unavailable",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })
);

/**
 * GET /mcp/servers/:slug/tools
 * Proxy to MCP server - list tools for a server
 */
app.get(
  "/mcp/servers/:slug/tools",
  asyncHandler(async (req: Request, res: Response) => {
    const { slug } = req.params;
    try {
      const response = await fetch(`${MCP_SERVER_URL}/mcp/servers/${encodeURIComponent(slug)}/tools`);
      const data = await response.json();
      res.status(response.status).json(data);
    } catch (error) {
      res.status(503).json({
        error: `Failed to fetch tools for ${slug}`,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })
);

const McpCallToolSchema = z.object({
  tool: z.string().min(1, "tool name is required"),
  args: z.record(z.string(), z.unknown()).optional().default({}),
});

/**
 * POST /mcp/servers/:slug/call
 * Proxy to MCP server - call a tool on a server
 */
app.post(
  "/mcp/servers/:slug/call",
  asyncHandler(async (req: Request, res: Response) => {
    const { slug } = req.params;

    // x402 Payment Verification - ALWAYS required, no session bypass
    const { paymentData } = extractPaymentInfo(
      req.headers as Record<string, string | string[] | undefined>
    );

    const resourceUrl = `https://${req.get("host")}${req.originalUrl}`;
    const paymentResult = await handleX402Payment(
      paymentData,
      resourceUrl,
      "POST",
      DEFAULT_PRICES.MCP_TOOL_CALL,
    );

    if (paymentResult.status !== 200) {
      Object.entries(paymentResult.responseHeaders).forEach(([key, value]) => {
        res.setHeader(key, value);
      });
      res.status(paymentResult.status).json(paymentResult.responseBody);
      return;
    }
    console.log(`[x402] Payment verified for mcp/${slug}`);

    const parseResult = McpCallToolSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: parseResult.error.issues,
      });
      return;
    }

    try {
      // Use the new /mcp/servers/:serverId/tools/:toolName endpoint
      const toolName = parseResult.data.tool;
      const response = await fetch(`${MCP_SERVER_URL}/mcp/servers/${encodeURIComponent(slug)}/tools/${encodeURIComponent(toolName)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ args: parseResult.data.args }),
      });
      const data = await response.json();
      res.status(response.status).json(data);
    } catch (error) {
      res.status(503).json({
        error: `Failed to call tool on ${slug}`,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })
);

// =============================================================================
// MCP Server Spawning Routes (Proxied to MCP Server)
// =============================================================================

/**
 * POST /mcp/spawn
 * Proxy to MCP server - spawn an MCP server and create session
 */
app.post(
  "/mcp/spawn",
  asyncHandler(async (req: Request, res: Response) => {
    // x402 Payment Verification
    const { paymentData } = extractPaymentInfo(
      req.headers as Record<string, string | string[] | undefined>
    );

    const resourceUrl = `https://${req.get("host")}${req.originalUrl}`;
    const paymentResult = await handleX402Payment(
      paymentData,
      resourceUrl,
      "POST",
      DEFAULT_PRICES.MCP_TOOL_CALL, // Same as tool execution
    );

    if (paymentResult.status !== 200) {
      Object.entries(paymentResult.responseHeaders).forEach(([key, value]) => {
        res.setHeader(key, value);
      });
      res.status(paymentResult.status).json(paymentResult.responseBody);
      return;
    }
    console.log(`[x402] Payment verified for mcp/spawn`);

    // Proxy to MCP server
    try {
      const response = await fetch(`${MCP_SERVER_URL}/mcp/spawn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req.body),
      });
      const data = await response.json();
      res.status(response.status).json(data);
    } catch (error) {
      res.status(503).json({
        error: "MCP server unavailable",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })
);

/**
 * GET /mcp/sessions
 * Proxy to MCP server - list active sessions
 */
app.get(
  "/mcp/sessions",
  asyncHandler(async (_req: Request, res: Response) => {
    try {
      const response = await fetch(`${MCP_SERVER_URL}/mcp/sessions`);
      const data = await response.json();
      res.json(data);
    } catch (error) {
      res.status(503).json({
        error: "MCP server unavailable",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })
);

/**
 * GET /mcp/sessions/:sessionId/tools
 * Proxy to MCP server - get tools from session
 */
app.get(
  "/mcp/sessions/:sessionId/tools",
  asyncHandler(async (req: Request, res: Response) => {
    const { sessionId } = req.params;
    try {
      const response = await fetch(`${MCP_SERVER_URL}/mcp/sessions/${encodeURIComponent(sessionId)}/tools`);
      const data = await response.json();
      res.status(response.status).json(data);
    } catch (error) {
      res.status(503).json({
        error: "MCP server unavailable",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })
);

/**
 * POST /mcp/sessions/:sessionId/execute
 * Proxy to MCP server - execute tool on session
 */
app.post(
  "/mcp/sessions/:sessionId/execute",
  asyncHandler(async (req: Request, res: Response) => {
    const { sessionId } = req.params;

    // x402 Payment Verification
    const { paymentData } = extractPaymentInfo(
      req.headers as Record<string, string | string[] | undefined>
    );

    const resourceUrl = `https://${req.get("host")}${req.originalUrl}`;
    const paymentResult = await handleX402Payment(
      paymentData,
      resourceUrl,
      "POST",
      DEFAULT_PRICES.MCP_TOOL_CALL,
    );

    if (paymentResult.status !== 200) {
      Object.entries(paymentResult.responseHeaders).forEach(([key, value]) => {
        res.setHeader(key, value);
      });
      res.status(paymentResult.status).json(paymentResult.responseBody);
      return;
    }
    console.log(`[x402] Payment verified for mcp/sessions/${sessionId}/execute`);

    // Proxy to MCP server
    try {
      const response = await fetch(`${MCP_SERVER_URL}/mcp/sessions/${encodeURIComponent(sessionId)}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req.body),
      });
      const data = await response.json();
      res.status(response.status).json(data);
    } catch (error) {
      res.status(503).json({
        error: "MCP server unavailable",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })
);

/**
 * DELETE /mcp/sessions/:sessionId
 * Proxy to MCP server - terminate session
 */
app.delete(
  "/mcp/sessions/:sessionId",
  asyncHandler(async (req: Request, res: Response) => {
    const { sessionId } = req.params;
    try {
      const response = await fetch(`${MCP_SERVER_URL}/mcp/sessions/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
      });
      const data = await response.json();
      res.status(response.status).json(data);
    } catch (error) {
      res.status(503).json({
        error: "MCP server unavailable",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })
);

// =============================================================================
// Agent Card Generation
// =============================================================================

/**
 * POST /cards/from-registry
 * Generate a ComposeAgentCard from a registry ID
 */
app.post(
  "/cards/from-registry",
  asyncHandler(async (req: Request, res: Response) => {
    const { registryId, options } = req.body;

    if (!registryId || typeof registryId !== "string") {
      res.status(400).json({ error: "registryId is required" });
      return;
    }

    try {
      const server = await getServerByRegistryId(registryId);
      if (!server) {
        res.status(404).json({ error: `Server not found: ${registryId}` });
        return;
      }

      const card = buildAgentCardFromRegistry(server, options);

      // Validate the generated card
      const validated = assertValidAgentCard(card);

      res.json({
        ok: true,
        card: validated,
      });
    } catch (error) {
      console.error("Error generating agent card:", error);
      const details = (error as any).details;
      res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        details,
      });
    }
  })
);

/**
 * POST /cards/validate
 * Validate an agent card
 */
app.post(
  "/cards/validate",
  asyncHandler(async (req: Request, res: Response) => {
    const { card } = req.body;

    if (!card) {
      res.status(400).json({ error: "card is required" });
      return;
    }

    const result = validateAgentCard(card);
    res.json(result);
  })
);

/**
 * POST /cards/preview
 * Generate a preview card from raw server metadata
 */
app.post(
  "/cards/preview",
  asyncHandler(async (req: Request, res: Response) => {
    const { server, options } = req.body;

    if (!server) {
      res.status(400).json({ error: "server record is required" });
      return;
    }

    try {
      // Cast input to UnifiedServerRecord (runtime validation implied by use)
      const record = server as UnifiedServerRecord;

      const card = buildAgentCardFromRegistry(record, options);
      const result = validateAgentCard(card);

      res.json(result);
    } catch (error) {
      console.error("Error previewing agent card:", error);
      res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })
);

// =============================================================================
// GOAT Plugin Routes (Proxied to MCP Server)
// =============================================================================

/**
 * GET /plugins
 * Proxy to MCP server - list all GOAT plugins (dynamically loaded)
 */
app.get(
  "/plugins",
  asyncHandler(async (_req: Request, res: Response) => {
    try {
      const response = await fetch(`${MCP_SERVER_URL}/goat/plugins`);
      const data = await response.json();
      res.json(data);
    } catch (error) {
      res.status(503).json({
        error: "MCP server unavailable",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })
);

/**
 * GET /plugins/status
 * Proxy to MCP server - GOAT runtime status
 */
app.get(
  "/plugins/status",
  asyncHandler(async (_req: Request, res: Response) => {
    try {
      const response = await fetch(`${MCP_SERVER_URL}/goat/status`);
      const data = await response.json();
      res.json(data);
    } catch (error) {
      res.status(503).json({
        error: "MCP server unavailable",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })
);

/**
 * GET /plugins/tools
 * Proxy to MCP server - list all GOAT tools across all plugins
 */
app.get(
  "/plugins/tools",
  asyncHandler(async (_req: Request, res: Response) => {
    try {
      const response = await fetch(`${MCP_SERVER_URL}/goat/tools`);
      const data = await response.json();
      res.json(data);
    } catch (error) {
      res.status(503).json({
        error: "MCP server unavailable",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })
);

/**
 * GET /plugins/:pluginId/tools
 * Proxy to MCP server - list tools for a GOAT plugin
 */
app.get(
  "/plugins/:pluginId/tools",
  asyncHandler(async (req: Request, res: Response) => {
    const { pluginId } = req.params;
    try {
      const response = await fetch(`${MCP_SERVER_URL}/goat/plugins/${encodeURIComponent(pluginId)}`);
      const data = await response.json();
      res.status(response.status).json(data);
    } catch (error) {
      res.status(503).json({
        error: `Failed to fetch tools for plugin ${pluginId}`,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })
);

const ExecuteToolSchema = z.object({
  tool: z.string().min(1, "tool name is required"),
  args: z.record(z.string(), z.unknown()).optional().default({}),
});

/**
 * POST /plugins/:pluginId/execute
 * Proxy to MCP server - execute a GOAT plugin tool
 */
app.post(
  "/plugins/:pluginId/execute",
  asyncHandler(async (req: Request, res: Response) => {
    const { pluginId } = req.params;

    // x402 Payment Verification - ALWAYS required, no session bypass
    const { paymentData } = extractPaymentInfo(
      req.headers as Record<string, string | string[] | undefined>
    );

    const resourceUrl = `https://${req.get("host")}${req.originalUrl}`;
    const paymentResult = await handleX402Payment(
      paymentData,
      resourceUrl,
      "POST",
      DEFAULT_PRICES.GOAT_EXECUTE,
    );

    if (paymentResult.status !== 200) {
      Object.entries(paymentResult.responseHeaders).forEach(([key, value]) => {
        res.setHeader(key, value);
      });
      res.status(paymentResult.status).json(paymentResult.responseBody);
      return;
    }
    console.log(`[x402] Payment verified for plugins/${pluginId}`);

    const parseResult = ExecuteToolSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: parseResult.error.issues,
      });
      return;
    }

    try {
      const response = await fetch(`${MCP_SERVER_URL}/goat/${encodeURIComponent(pluginId)}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parseResult.data),
      });
      const data = await response.json();
      res.status(response.status).json(data);
    } catch (error) {
      res.status(503).json({
        error: `Failed to execute plugin ${pluginId}`,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })
);

// =============================================================================
// ElizaOS Plugin Routes (Proxied to MCP Server)
// Users build their OWN agents and equip them with ElizaOS plugins.
// These routes let users:
// 1. List all available plugins from the ElizaOS registry
// 2. Get action schemas with detailed JSON parameter definitions
// 3. Test individual actions before deploying to agents
// =============================================================================

/**
 * GET /eliza/status
 * Proxy to MCP server - ElizaOS runtime status
 */
app.get(
  "/eliza/status",
  asyncHandler(async (_req: Request, res: Response) => {
    try {
      const response = await fetch(`${MCP_SERVER_URL}/eliza/status`);
      const data = await response.json();
      res.json(data);
    } catch (error) {
      res.status(503).json({
        error: "MCP server unavailable",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })
);

/**
 * GET /eliza/plugins
 * Proxy to MCP server - list available ElizaOS plugins
 * Query params: search, category
 */
app.get(
  "/eliza/plugins",
  asyncHandler(async (req: Request, res: Response) => {
    try {
      // Forward query params
      const url = new URL(`${MCP_SERVER_URL}/eliza/plugins`);
      if (req.query.search) url.searchParams.set("search", String(req.query.search));
      if (req.query.category) url.searchParams.set("category", String(req.query.category));

      const response = await fetch(url.toString());
      const data = await response.json();
      res.json(data);
    } catch (error) {
      res.status(503).json({
        error: "MCP server unavailable",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })
);

/**
 * GET /eliza/plugins/:pluginId
 * Proxy to MCP server - get plugin details
 */
app.get(
  "/eliza/plugins/:pluginId",
  asyncHandler(async (req: Request, res: Response) => {
    const { pluginId } = req.params;
    try {
      const response = await fetch(`${MCP_SERVER_URL}/eliza/plugins/${encodeURIComponent(pluginId)}`);
      const data = await response.json();
      res.status(response.status).json(data);
    } catch (error) {
      res.status(503).json({
        error: `Failed to fetch plugin ${pluginId}`,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })
);

/**
 * GET /eliza/plugins/:pluginId/actions
 * Proxy to MCP server - get action schemas with full JSON parameter definitions
 * This is the KEY endpoint for frontend to display action parameter forms
 */
app.get(
  "/eliza/plugins/:pluginId/actions",
  asyncHandler(async (req: Request, res: Response) => {
    const { pluginId } = req.params;
    try {
      const response = await fetch(`${MCP_SERVER_URL}/eliza/plugins/${encodeURIComponent(pluginId)}/actions`);
      const data = await response.json();
      res.status(response.status).json(data);
    } catch (error) {
      res.status(503).json({
        error: `Failed to fetch actions for plugin ${pluginId}`,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })
);

/**
 * GET /eliza/plugins/:pluginId/actions/:actionName
 * Proxy to MCP server - get specific action schema
 */
app.get(
  "/eliza/plugins/:pluginId/actions/:actionName",
  asyncHandler(async (req: Request, res: Response) => {
    const { pluginId, actionName } = req.params;
    try {
      const response = await fetch(
        `${MCP_SERVER_URL}/eliza/plugins/${encodeURIComponent(pluginId)}/actions/${encodeURIComponent(actionName)}`
      );
      const data = await response.json();
      res.status(response.status).json(data);
    } catch (error) {
      res.status(503).json({
        error: `Failed to fetch action ${actionName} for plugin ${pluginId}`,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })
);

/**
 * GET /eliza/plugins/:pluginId/actions/:actionName/example
 * Proxy to MCP server - get example request body for an action
 */
app.get(
  "/eliza/plugins/:pluginId/actions/:actionName/example",
  asyncHandler(async (req: Request, res: Response) => {
    const { pluginId, actionName } = req.params;
    try {
      const response = await fetch(
        `${MCP_SERVER_URL}/eliza/plugins/${encodeURIComponent(pluginId)}/actions/${encodeURIComponent(actionName)}/example`
      );
      const data = await response.json();
      res.status(response.status).json(data);
    } catch (error) {
      res.status(503).json({
        error: `Failed to fetch example for action ${actionName}`,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })
);

const ElizaExecuteSchema = z.object({
  action: z.string().min(1, "action name is required"),
  params: z.record(z.string(), z.unknown()).optional().default({}),
  modelId: z.string().optional(),
});

/**
 * POST /eliza/plugins/:pluginId/execute
 * Proxy to MCP server - execute an ElizaOS plugin action
 * This is for TESTING actions before equipping them on user agents
 * 
 * Body: { action: string, params: Record<string, unknown>, modelId?: string }
 * 
 * All executions require x402 payment.
 */
app.post(
  "/eliza/plugins/:pluginId/execute",
  asyncHandler(async (req: Request, res: Response) => {
    const { pluginId } = req.params;

    // x402 Payment Verification - ALWAYS required, no session bypass
    const { paymentData } = extractPaymentInfo(
      req.headers as Record<string, string | string[] | undefined>
    );

    const resourceUrl = `https://${req.get("host")}${req.originalUrl}`;
    const paymentResult = await handleX402Payment(
      paymentData,
      resourceUrl,
      "POST",
      DEFAULT_PRICES.ELIZA_ACTION,
    );

    if (paymentResult.status !== 200) {
      Object.entries(paymentResult.responseHeaders).forEach(([key, value]) => {
        res.setHeader(key, value);
      });
      res.status(paymentResult.status).json(paymentResult.responseBody);
      return;
    }
    console.log(`[x402] Payment verified for eliza/${pluginId}/execute`);

    const parseResult = ElizaExecuteSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: parseResult.error.issues,
        hint: "Request body should be: { action: string, params: {}, modelId?: string }",
      });
      return;
    }

    try {
      const response = await fetch(
        `${MCP_SERVER_URL}/eliza/plugins/${encodeURIComponent(pluginId)}/execute`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(parseResult.data),
        }
      );
      const data = await response.json();
      res.status(response.status).json(data);
    } catch (error) {
      res.status(503).json({
        error: `Failed to execute action on plugin ${pluginId}`,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })
);

// =============================================================================
// Error Handler
// =============================================================================

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Unhandled error:", err);
  res.status(500).json({
    error: "Internal server error",
    message: err.message,
  });
});

// =============================================================================
// Server Startup
// =============================================================================

const PORT = parseInt(process.env.PORT || "4001", 10);

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🔌 Connector Hub listening on http://0.0.0.0:${PORT}`);
  console.log(`\n🚀 MCP Server: ${MCP_SERVER_URL}`);
  console.log("\n⚠️  NOTE: All execution is proxied to MCP Server - no local execution!");
  console.log("\nEndpoints:");
  console.log("  GET  /health              - Health check");
  console.log("");
  console.log("  GET  /registry/servers    - List MCP servers");
  console.log("  GET  /registry/servers/search - Search MCP servers");
  console.log("  GET  /registry/servers/:id - Get server by ID");
  console.log("  GET  /registry/categories - List categories");
  console.log("  GET  /registry/tags       - List tags");
  console.log("  GET  /registry/meta       - Registry metadata");
  console.log("");
  console.log("  GET  /mcp/servers         - [PROXY] List spawnable MCP servers");
  console.log("  GET  /mcp/status          - [PROXY] Spawned server status");
  console.log("  GET  /mcp/servers/:slug/tools - [PROXY] List tools");
  console.log("  POST /mcp/servers/:slug/call  - [PROXY] Call tool");
  console.log("");
  console.log("  POST /cards/from-registry - Generate agent card");
  console.log("  POST /cards/validate      - Validate agent card");
  console.log("  POST /cards/preview       - Preview agent card");
  console.log("");
  console.log("  GET  /plugins/status      - [PROXY] GOAT runtime status");
  console.log("  GET  /plugins/tools       - [PROXY] List all GOAT tools");
  console.log("  GET  /plugins/:id/tools   - [PROXY] List plugin tools");
  console.log("  POST /plugins/:id/execute - [PROXY] Execute plugin tool");
  console.log("");
  console.log("  GET  /eliza/status        - [PROXY] ElizaOS runtime status");
  console.log("  GET  /eliza/agents/:id/actions - [PROXY] List agent actions");
  console.log("  POST /eliza/agents/:id/message - [PROXY] Send message");
  console.log("  POST /eliza/agents/:id/actions/:name - [PROXY] Execute action");
  console.log("");
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("\nReceived SIGTERM, shutting down gracefully...");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});

process.on("SIGINT", async () => {
  console.log("\nReceived SIGINT, shutting down gracefully...");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});

export default app;
