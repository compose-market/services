/**
 * Workflow Engine
 * 
 * Core orchestrator that executes workflow steps sequentially,
 * calling the Connector Hub for each step and maintaining shared context.
 */
import { CONNECTOR_BASE_URL, CONNECTOR_TIMEOUT_MS, MAX_WORKFLOW_STEPS } from "../../shared/config.js";
import { resolveTemplate } from "./template.js";
import type {
  WorkflowDefinition,
  WorkflowRunResult,
  WorkflowStep,
  StepLog,
  ConnectorCallResponse
} from "./types.js";

/**
 * Call a tool on the Connector Hub.
 * 
 * @param connectorId - The connector to call (e.g., "x", "notion")
 * @param toolName - The tool to invoke
 * @param args - Arguments to pass to the tool
 * @returns The connector's response
 */
async function callConnectorTool(
  connectorId: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<ConnectorCallResponse> {
  const url = `${CONNECTOR_BASE_URL}/connectors/${encodeURIComponent(connectorId)}/call`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CONNECTOR_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ toolName, args }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Connector call failed (${response.status} ${response.statusText}): ${errorText}`
      );
    }

    return await response.json() as ConnectorCallResponse;
  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Connector call timed out after ${CONNECTOR_TIMEOUT_MS}ms`);
    }

    throw error;
  }
}

/**
 * Execute a single workflow step.
 * 
 * @param step - The step to execute
 * @param context - Current execution context
 * @returns Step execution log
 */
async function executeStep(
  step: WorkflowStep,
  context: Record<string, unknown>
): Promise<{ log: StepLog; result?: ConnectorCallResponse }> {
  const startedAt = new Date().toISOString();

  // Resolve template placeholders in arguments
  const resolvedArgs = resolveTemplate<Record<string, unknown>>(
    step.inputTemplate,
    context
  );

  try {
    const result = await callConnectorTool(
      step.connectorId,
      step.toolName,
      resolvedArgs
    );

    const finishedAt = new Date().toISOString();

    // Check if the connector reported an error
    if (!result.success) {
      return {
        log: {
          stepId: step.id,
          name: step.name,
          connectorId: step.connectorId,
          toolName: step.toolName,
          startedAt,
          finishedAt,
          status: "error",
          args: resolvedArgs,
          error: `Connector returned error: ${JSON.stringify(result.content)}`
        }
      };
    }

    return {
      log: {
        stepId: step.id,
        name: step.name,
        connectorId: step.connectorId,
        toolName: step.toolName,
        startedAt,
        finishedAt,
        status: "success",
        args: resolvedArgs,
        output: result
      },
      result
    };
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);

    return {
      log: {
        stepId: step.id,
        name: step.name,
        connectorId: step.connectorId,
        toolName: step.toolName,
        startedAt,
        finishedAt,
        status: "error",
        args: resolvedArgs,
        error: message
      }
    };
  }
}

/**
 * Run a complete workflow.
 * 
 * Executes steps sequentially, maintaining shared context.
 * Stops on first error and returns partial results.
 * 
 * @param workflow - The workflow definition to execute
 * @param initialInput - Initial input data (accessible as {{input.xxx}})
 * @returns Execution result with context and logs
 */
export async function runWorkflow(
  workflow: WorkflowDefinition,
  initialInput: Record<string, unknown>
): Promise<WorkflowRunResult> {
  // Validate workflow
  if (workflow.steps.length > MAX_WORKFLOW_STEPS) {
    return {
      workflowId: workflow.id,
      success: false,
      context: { input: initialInput },
      logs: [{
        stepId: "validation",
        name: "Workflow Validation",
        connectorId: "",
        toolName: "",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        status: "error",
        args: {},
        error: `Workflow exceeds maximum of ${MAX_WORKFLOW_STEPS} steps (has ${workflow.steps.length})`
      }]
    };
  }

  // Initialize context with input
  const context: Record<string, unknown> = {
    input: initialInput
  };

  const logs: StepLog[] = [];

  console.log(`[workflow] Starting "${workflow.name}" (${workflow.id}) with ${workflow.steps.length} step(s)`);

  // Execute steps sequentially
  for (let i = 0; i < workflow.steps.length; i++) {
    const step = workflow.steps[i];
    console.log(`[workflow] Step ${i + 1}/${workflow.steps.length}: ${step.name} (${step.connectorId}/${step.toolName})`);

    const { log, result } = await executeStep(step, context);
    logs.push(log);

    if (log.status === "error") {
      console.log(`[workflow] Step failed: ${log.error}`);
      return {
        workflowId: workflow.id,
        success: false,
        context,
        logs
      };
    }

    // Store result in context under saveAs key
    if (result) {
      context[step.saveAs] = result;
      console.log(`[workflow] Step completed, saved to context.${step.saveAs}`);
    }
  }

  console.log(`[workflow] Completed successfully`);

  return {
    workflowId: workflow.id,
    success: true,
    context,
    logs
  };
}

/**
 * Validate a workflow definition without executing it.
 * 
 * @param workflow - The workflow to validate
 * @returns Array of validation errors (empty if valid)
 */
export function validateWorkflow(workflow: WorkflowDefinition): string[] {
  const errors: string[] = [];

  if (!workflow.id || workflow.id.trim() === "") {
    errors.push("Workflow ID is required");
  }

  if (!workflow.name || workflow.name.trim() === "") {
    errors.push("Workflow name is required");
  }

  if (!workflow.steps || workflow.steps.length === 0) {
    errors.push("Workflow must have at least one step");
  }

  if (workflow.steps.length > MAX_WORKFLOW_STEPS) {
    errors.push(`Workflow exceeds maximum of ${MAX_WORKFLOW_STEPS} steps`);
  }

  const stepIds = new Set<string>();
  const saveAsKeys = new Set<string>();

  for (let i = 0; i < workflow.steps.length; i++) {
    const step = workflow.steps[i];
    const prefix = `Step ${i + 1}`;

    if (!step.id || step.id.trim() === "") {
      errors.push(`${prefix}: ID is required`);
    } else if (stepIds.has(step.id)) {
      errors.push(`${prefix}: Duplicate step ID "${step.id}"`);
    } else {
      stepIds.add(step.id);
    }

    if (!step.name || step.name.trim() === "") {
      errors.push(`${prefix}: Name is required`);
    }

    if (!step.connectorId || step.connectorId.trim() === "") {
      errors.push(`${prefix}: Connector ID is required`);
    }

    if (!step.toolName || step.toolName.trim() === "") {
      errors.push(`${prefix}: Tool name is required`);
    }

    if (!step.saveAs || step.saveAs.trim() === "") {
      errors.push(`${prefix}: saveAs is required`);
    } else if (saveAsKeys.has(step.saveAs)) {
      errors.push(`${prefix}: Duplicate saveAs key "${step.saveAs}"`);
    } else {
      saveAsKeys.add(step.saveAs);
    }
  }

  return errors;
}

