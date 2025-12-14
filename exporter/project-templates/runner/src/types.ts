/**
 * Workflow Types
 * 
 * Defines the structure for workflows, steps, and execution results.
 */

export type StepType = "connectorTool";

export interface WorkflowStep {
  id: string;
  name: string;
  description?: string;
  type: StepType;
  connectorId: string;
  toolName: string;
  inputTemplate: Record<string, unknown>;
  saveAs: string;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  description?: string;
  steps: WorkflowStep[];
}

export interface StepLog {
  stepId: string;
  name: string;
  connectorId: string;
  toolName: string;
  startedAt: string;
  finishedAt: string;
  status: "success" | "error";
  args: Record<string, unknown>;
  output?: unknown;
  error?: string;
}

export interface WorkflowRunResult {
  workflowId: string;
  success: boolean;
  context: Record<string, unknown>;
  logs: StepLog[];
}

export interface ConnectorCallResponse {
  connector: string;
  tool: string;
  success: boolean;
  content: unknown;
  raw: unknown;
}

