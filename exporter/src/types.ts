/**
 * Exporter Service Types
 * 
 * Defines workflow structure (same as sandbox) plus export-specific metadata.
 */

/** Supported step types - for v1 we only support connector tool calls */
export type StepType = "connectorTool";

/**
 * A single step in the workflow.
 * Each step calls a tool on a connector via the Connector Hub.
 */
export interface WorkflowStep {
  /** Unique ID within this workflow */
  id: string;
  
  /** Human-readable name */
  name: string;
  
  /** Optional description */
  description?: string;
  
  /** Step type - currently only "connectorTool" */
  type: StepType;
  
  /** Connector ID from Connector Hub (e.g., "notion", "x", "discord") */
  connectorId: string;
  
  /** MCP tool name exposed by the connector */
  toolName: string;
  
  /**
   * JSON template for tool arguments.
   * Strings can contain {{path.to.value}} placeholders resolved from context.
   */
  inputTemplate: Record<string, unknown>;
  
  /** Where to store the result in context, e.g. "steps.create_page" */
  saveAs: string;
}

/**
 * Complete workflow definition as sent from the UI.
 */
export interface WorkflowDefinition {
  /** Unique workflow ID */
  id: string;
  
  /** Human-readable name */
  name: string;
  
  /** Optional description */
  description?: string;
  
  /** Ordered list of steps to execute */
  steps: WorkflowStep[];
}

/**
 * Execution log for a single step.
 */
export interface StepLog {
  /** Step ID from the workflow definition */
  stepId: string;
  
  /** Step name */
  name: string;
  
  /** Connector that was called */
  connectorId: string;
  
  /** Tool that was invoked */
  toolName: string;
  
  /** ISO timestamp when step started */
  startedAt: string;
  
  /** ISO timestamp when step finished */
  finishedAt: string;
  
  /** Execution status */
  status: "success" | "error";
  
  /** Resolved arguments that were sent to the connector */
  args: Record<string, unknown>;
  
  /** Tool output (on success) */
  output?: unknown;
  
  /** Error message (on failure) */
  error?: string;
}

/**
 * Result of running a workflow.
 */
export interface WorkflowRunResult {
  /** Workflow ID that was executed */
  workflowId: string;
  
  /** Overall success status */
  success: boolean;
  
  /** Final context with all step results */
  context: Record<string, unknown>;
  
  /** Execution logs for each step */
  logs: StepLog[];
}

/**
 * Response from Connector Hub's /connectors/:id/call endpoint.
 */
export interface ConnectorCallResponse {
  connector: string;
  tool: string;
  success: boolean;
  content: unknown;
  raw: unknown;
}

/**
 * Metadata for export requests (exporter-only).
 */
export interface ExportMetadata {
  /** Custom project name (defaults to workflow name) */
  projectName?: string;
  
  /** Project description (defaults to workflow description) */
  description?: string;
  
  /** Author name (optional) */
  author?: string;
}

