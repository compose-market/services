/**
 * Sandbox Service HTTP API
 * 
 * Provides endpoints for testing and executing workflows in a sandbox environment.
 */
import "dotenv/config";
import express, { type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { PORTS, CONNECTOR_BASE_URL } from "../../shared/config.js";
import { runWorkflow, validateWorkflow } from "./workflowEngine.js";
import type { WorkflowDefinition, WorkflowStep } from "./types.js";
import {
  handleX402Payment,
  extractPaymentInfo,
  DEFAULT_PRICES,
} from "../../shared/payment.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

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

// =============================================================================
// Zod Schemas for API Validation
// =============================================================================

const StepSchema: z.ZodSchema<WorkflowStep> = z.object({
  id: z.string().min(1, "Step ID is required"),
  name: z.string().min(1, "Step name is required"),
  description: z.string().optional(),
  type: z.literal("connectorTool"),
  connectorId: z.string().min(1, "Connector ID is required"),
  toolName: z.string().min(1, "Tool name is required"),
  inputTemplate: z.record(z.string(), z.unknown()).default({}),
  saveAs: z.string().min(1, "saveAs is required")
});

const WorkflowSchema = z.object({
  id: z.string().min(1, "Workflow ID is required"),
  name: z.string().min(1, "Workflow name is required"),
  description: z.string().optional(),
  steps: z.array(StepSchema).min(1, "At least one step is required")
});

const RunRequestSchema = z.object({
  workflow: WorkflowSchema,
  input: z.record(z.string(), z.unknown()).default({})
});

const ValidateRequestSchema = z.object({
  workflow: WorkflowSchema
});

// =============================================================================
// Routes
// =============================================================================

/**
 * GET /health
 * Health check endpoint
 */
app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "sandbox",
    version: "0.1.0",
    timestamp: new Date().toISOString(),
    connectorHub: CONNECTOR_BASE_URL
  });
});

/**
 * POST /sandbox/run
 * Execute a workflow with given input
 * 
 * Body: {
 *   workflow: WorkflowDefinition,
 *   input: Record<string, unknown>
 * }
 */
app.post(
  "/sandbox/run",
  asyncHandler(async (req: Request, res: Response) => {
    // x402 Payment Verification - ALWAYS required, no session bypass
    const { paymentData } = extractPaymentInfo(
      req.headers as Record<string, string | string[] | undefined>
    );

    const resourceUrl = `https://${req.get("host")}${req.originalUrl}`;
    const paymentResult = await handleX402Payment(
      paymentData,
      resourceUrl,
      "POST",
      DEFAULT_PRICES.WORKFLOW_RUN,
    );

    if (paymentResult.status !== 200) {
      Object.entries(paymentResult.responseHeaders).forEach(([key, value]) => {
        res.setHeader(key, value);
      });
      res.status(paymentResult.status).json(paymentResult.responseBody);
      return;
    }
    console.log(`[x402] Payment verified for sandbox/run`);


    const parseResult = RunRequestSchema.safeParse(req.body);

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

    const { workflow, input } = parseResult.data;

    // Validate workflow structure
    const validationErrors = validateWorkflow(workflow);
    if (validationErrors.length > 0) {
      res.status(400).json({
        error: "Workflow validation failed",
        details: validationErrors
      });
      return;
    }

    // Execute workflow
    const result = await runWorkflow(workflow, input);
    res.json(result);
  })
);

/**
 * POST /sandbox/validate
 * Validate a workflow definition without executing it
 * 
 * Body: {
 *   workflow: WorkflowDefinition
 * }
 */
app.post(
  "/sandbox/validate",
  asyncHandler(async (req: Request, res: Response) => {
    const parseResult = ValidateRequestSchema.safeParse(req.body);

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

    const { workflow } = parseResult.data;
    const errors = validateWorkflow(workflow);

    res.json({
      valid: errors.length === 0,
      errors
    });
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
    const { id } = req.params;

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
  console.log(`\n🧪 Sandbox Service listening on http://0.0.0.0:${PORTS.SANDBOX}`);
  console.log(`   Connector Hub: ${CONNECTOR_BASE_URL}`);
  console.log("\nEndpoints:");
  console.log("  GET  /health                     - Health check");
  console.log("  POST /sandbox/run                - Execute workflow");
  console.log("  POST /sandbox/validate           - Validate workflow");
  console.log("  GET  /sandbox/connectors         - List connectors (proxy)");
  console.log("  GET  /sandbox/connectors/:id/tools - List tools (proxy)");
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

