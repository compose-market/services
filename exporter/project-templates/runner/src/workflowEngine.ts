/**
 * Workflow Engine
 *
 * Executes workflow steps sequentially, calling the Connector Hub
 * and maintaining a shared context object.
 * 
 * Supports x402 payments for autonomous execution when SERVER_PRIVATE_KEY is configured.
 */
import {
  CONNECTOR_BASE_URL,
  CONNECTOR_TIMEOUT_MS
} from "./config.js";
import { resolveTemplate } from "./template.js";
import { getPaymentFetch, isPaymentConfigured } from "./payment.js";
import type {
  WorkflowDefinition,
  WorkflowRunResult,
  WorkflowStep,
  StepLog,
  ConnectorCallResponse
} from "./types.js";

// Get payment-wrapped fetch for x402 payments (falls back to standard fetch if not configured)
const paymentFetch = getPaymentFetch();

async function callConnectorTool(
  connectorId: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<ConnectorCallResponse> {
  const url = `${CONNECTOR_BASE_URL}/connectors/${encodeURIComponent(
    connectorId
  )}/call`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CONNECTOR_TIMEOUT_MS);

  try {
    // Use payment-wrapped fetch for x402 support
    const response = await paymentFetch(url, {
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

    return (await response.json()) as ConnectorCallResponse;
  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(
        `Connector call timed out after ${CONNECTOR_TIMEOUT_MS}ms`
      );
    }

    throw error;
  }
}

async function executeStep(
  step: WorkflowStep,
  context: Record<string, unknown>
): Promise<{ log: StepLog; result?: ConnectorCallResponse }> {
  const startedAt = new Date().toISOString();

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

export async function runWorkflow(
  workflow: WorkflowDefinition,
  initialInput: Record<string, unknown>
): Promise<WorkflowRunResult> {
  const context: Record<string, unknown> = {
    input: initialInput
  };

  const logs: StepLog[] = [];

  console.log(
    `[workflow] Starting "${workflow.name}" (${workflow.id}) with ${workflow.steps.length} step(s)`
  );
  console.log(
    `[workflow] Autonomous payments: ${isPaymentConfigured() ? "ENABLED" : "DISABLED (set SERVER_PRIVATE_KEY)"}`
  );

  for (let i = 0; i < workflow.steps.length; i++) {
    const step = workflow.steps[i];
    console.log(
      `[workflow] Step ${i + 1}/${workflow.steps.length}: ${step.name} (${step.connectorId}/${step.toolName})`
    );

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

    if (result) {
      context[step.saveAs] = result;
      console.log(
        `[workflow] Step completed, saved to context.${step.saveAs}`
      );
    }
  }

  console.log("[workflow] Completed successfully");

  return {
    workflowId: workflow.id,
    success: true,
    context,
    logs
  };
}

