/**
 * Exporter Service HTTP API
 *
 * POST /export/workflow -> returns a zip with a runnable Node/TS project
 * for the given workflow definition.
 */
import "dotenv/config";
import express, {
  type Request,
  type Response,
  type NextFunction
} from "express";
import { z } from "zod";
import archiver from "archiver";
import { PORTS } from "../../shared/config.js";
import type { WorkflowDefinition } from "./types.js";
import { addWorkflowProjectToArchive } from "./projectTemplate.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

// Request logging middleware
app.use((req: Request, _res: Response, next: NextFunction) => {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${req.method} ${req.path}`);
  next();
});

// CORS is handled by Nginx reverse proxy - do not add headers here to avoid duplicates

// Async wrapper
function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

// =============================================================================
// Zod Schemas
// =============================================================================

const StepSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  type: z.literal("connectorTool"),
  connectorId: z.string().min(1),
  toolName: z.string().min(1),
  inputTemplate: z.record(z.string(), z.unknown()).default({}),
  saveAs: z.string().min(1)
});

const WorkflowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  steps: z.array(StepSchema).min(1)
});

const ExportRequestSchema = z.object({
  workflow: WorkflowSchema,
  projectName: z.string().optional(),
  description: z.string().optional(),
  author: z.string().optional()
});

// =============================================================================
// Routes
// =============================================================================

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "exporter",
    version: "0.1.0",
    timestamp: new Date().toISOString()
  });
});

/**
 * POST /export/workflow
 * 
 * Body:
 * {
 *   workflow: WorkflowDefinition,
 *   projectName?: string,
 *   description?: string,
 *   author?: string
 * }
 * 
 * Returns: application/zip
 */
app.post(
  "/export/workflow",
  asyncHandler(async (req: Request, res: Response) => {
    const parse = ExportRequestSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: parse.error.issues.map((e) => ({
          path: e.path.join("."),
          message: e.message
        }))
      });
      return;
    }

    const { workflow, projectName, description, author } = parse.data;

    // Generate a safe filename
    const filenameBase =
      (projectName || workflow.name || `workflow-${workflow.id}`)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "workflow";

    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filenameBase}.zip"`
    );

    const archive = archiver("zip", { zlib: { level: 9 } });

    archive.on("error", (err) => {
      console.error("[exporter] archive error:", err);
      res.status(500).end();
    });

    archive.pipe(res);

    await addWorkflowProjectToArchive(archive, workflow, {
      projectName,
      description,
      author
    });

    await archive.finalize();

    console.log(`[exporter] Exported workflow "${workflow.name}" (${workflow.id})`);
  })
);

// =============================================================================
// Error Handler
// =============================================================================

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[exporter] unhandled error:", err);
  res.status(500).json({
    error: "Internal server error",
    message: err.message
  });
});

// =============================================================================
// Server Startup
// =============================================================================

const server = app.listen(PORTS.EXPORTER, "0.0.0.0", () => {
  console.log(`\n📦 Exporter Service listening on http://0.0.0.0:${PORTS.EXPORTER}`);
  console.log("\nEndpoints:");
  console.log("  GET  /health          - Health check");
  console.log("  POST /export/workflow - Export workflow as zip");
  console.log("");
});

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

