/**
 * Exported Workflow Server
 * 
 * A self-contained HTTP server that runs the embedded workflow.
 */
import express, { type Request, type Response } from "express";
import { PORT } from "./config.js";
import { WORKFLOW } from "./workflowDefinition.js";
import { runWorkflow } from "./workflowEngine.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

// CORS middleware
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  
  next();
});

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "exported-workflow",
    workflowId: WORKFLOW.id,
    workflowName: WORKFLOW.name,
    timestamp: new Date().toISOString()
  });
});

app.post("/run", async (req: Request, res: Response) => {
  const input =
    (req.body && typeof req.body === "object" && req.body.input) || {};

  try {
    const result = await runWorkflow(WORKFLOW, input as Record<string, unknown>);
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[exported-workflow] error:", error);
    res.status(500).json({
      error: "Workflow execution failed",
      message
    });
  }
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🚀 Exported Workflow listening on http://0.0.0.0:${PORT}`);
  console.log(`   Workflow: "${WORKFLOW.name}" (${WORKFLOW.id})`);
  console.log(`   Steps: ${WORKFLOW.steps.length}`);
  console.log("\nEndpoints:");
  console.log("  GET  /health - Health check");
  console.log("  POST /run    - Execute workflow with { input: {...} }");
  console.log("");
});

process.on("SIGTERM", () => {
  console.log("\nReceived SIGTERM, shutting down...");
  server.close(() => process.exit(0));
});

process.on("SIGINT", () => {
  console.log("\nReceived SIGINT, shutting down...");
  server.close(() => process.exit(0));
});

