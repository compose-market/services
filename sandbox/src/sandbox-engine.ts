/**
 * Sandbox Execution Engine
 *
 * Orchestrates sandboxed agent execution with:
 * - Docker container isolation
 * - Lambda-backed memory integration
 * - Backpack connector access
 */

import { SandboxDockerManager, type SandboxConfig } from "./docker-manager.js";

const LAMBDA_API_URL = process.env.LAMBDA_API_URL || process.env.API_URL || "https://api.compose.market";
const MANOWAR_INTERNAL_SECRET = process.env.MANOWAR_INTERNAL_SECRET;

function buildInternalHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
    };
    if (MANOWAR_INTERNAL_SECRET) {
        headers["x-manowar-internal"] = MANOWAR_INTERNAL_SECRET;
    }
    return headers;
}

// =============================================================================
// Types
// =============================================================================

export interface SandboxExecutionParams {
    sessionKey: string;
    agentWallet: string;
    framework: "langchain" | "openclaw";
    message: string;
    userId?: string;
    grantedPermissions: string[];
    workspaceDir?: string;
    workspaceAccess?: "none" | "ro" | "rw";
    networkAllow?: string[];
    resourceLimits?: {
        memory?: number;
        cpuShares?: number;
        pidsLimit?: number;
        timeoutMs?: number;
    };
    conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface SandboxExecutionResult {
    success: boolean;
    content: string;
    containerName: string;
    duration: number;
    memoryStored: number;
    toolCalls?: Array<{ name: string; args: Record<string, unknown>; result: unknown }>;
}

// =============================================================================
// Sandbox Engine
// =============================================================================

export class SandboxExecutionEngine {
    private docker: SandboxDockerManager;

    constructor() {
        this.docker = new SandboxDockerManager();
    }

    // -------------------------------------------------------------------------
    // Agent Execution
    // -------------------------------------------------------------------------

    async executeAgent(params: SandboxExecutionParams): Promise<SandboxExecutionResult> {
        const startTime = Date.now();

        // 1. Retrieve memory context before execution
        const memoryContext = await this.getMemoryContext({
            query: params.message,
            agentWallet: params.agentWallet,
            userId: params.userId,
        });

        // 2. Create/reuse sandbox container
        const config: SandboxConfig = {
            sessionKey: params.sessionKey,
            agentWallet: params.agentWallet,
            framework: params.framework,
            workspaceDir: params.workspaceDir,
            workspaceAccess: params.workspaceAccess || "none",
            networkAllow: params.networkAllow || [],
            resourceLimits: params.resourceLimits,
        };

        let containerName: string;
        try {
            containerName = await this.docker.createSandbox(config);
        } catch (error) {
            return {
                success: false,
                content: `Failed to create sandbox: ${error instanceof Error ? error.message : "Unknown error"}`,
                containerName: "",
                duration: Date.now() - startTime,
                memoryStored: 0,
            };
        }

        // 3. Execute agent in container
        const command = this.buildExecutionCommand(params, memoryContext);
        const result = await this.docker.executeInSandbox(
            containerName,
            command,
            params.resourceLimits?.timeoutMs || 120000
        );

        // 4. Store interaction in memory
        const memoryStored = result.success
            ? await this.storeInteraction({
                agentWallet: params.agentWallet,
                userId: params.userId,
                userMessage: params.message,
                assistantMessage: result.stdout,
            })
            : 0;

        return {
            success: result.success,
            content: result.stdout || result.stderr,
            containerName,
            duration: result.duration,
            memoryStored,
        };
    }

    // -------------------------------------------------------------------------
    // Container Management
    // -------------------------------------------------------------------------

    async createContainer(config: SandboxConfig): Promise<string> {
        return this.docker.createSandbox(config);
    }

    async destroyContainer(containerName: string): Promise<void> {
        return this.docker.destroySandbox(containerName);
    }

    async getContainerInfo(containerName: string) {
        return this.docker.getContainerInfo(containerName);
    }

    async listContainers() {
        return this.docker.listSandboxes();
    }

    async cleanup(maxAgeMs?: number): Promise<number> {
        return this.docker.cleanupIdleSandboxes(maxAgeMs);
    }

    // -------------------------------------------------------------------------
    // Private Helpers
    // -------------------------------------------------------------------------

    private async getMemoryContext(params: {
        query: string;
        agentWallet: string;
        userId?: string;
    }): Promise<string> {
        try {
            const response = await fetch(`${LAMBDA_API_URL}/api/memory/search`, {
                method: "POST",
                headers: buildInternalHeaders(),
                body: JSON.stringify({
                    query: params.query,
                    agentWallet: params.agentWallet,
                    userId: params.userId,
                    limit: 8,
                    enableGraph: true,
                }),
            });
            if (!response.ok) {
                return "";
            }

            const items = await response.json() as Array<{ memory?: string; content?: string }>;
            if (!Array.isArray(items) || items.length === 0) {
                return "";
            }

            const lines = items
                .map((item) => item.memory || item.content || "")
                .filter((value) => value.length > 0)
                .slice(0, 8);

            if (lines.length === 0) {
                return "";
            }

            return `[Memory Context]\n${lines.map((line) => `- ${line}`).join("\n")}`;
        } catch {
            return "";
        }
    }

    private async storeInteraction(params: {
        agentWallet: string;
        userId?: string;
        userMessage: string;
        assistantMessage: string;
    }): Promise<number> {
        try {
            const response = await fetch(`${LAMBDA_API_URL}/api/memory/add`, {
                method: "POST",
                headers: buildInternalHeaders(),
                body: JSON.stringify({
                    agentWallet: params.agentWallet,
                    userId: params.userId,
                    messages: [
                        { role: "user", content: params.userMessage },
                        { role: "assistant", content: params.assistantMessage },
                    ],
                    enableGraph: true,
                    metadata: {
                        source: "sandbox",
                        timestamp: Date.now(),
                    },
                }),
            });
            if (!response.ok) {
                return 0;
            }
            const result = await response.json();
            return Array.isArray(result) ? result.length : 0;
        } catch {
            return 0;
        }
    }

    private buildExecutionCommand(
        params: SandboxExecutionParams,
        memoryContext: string
    ): string[] {
        const payload = {
            message: params.message,
            agentWallet: params.agentWallet,
            userId: params.userId,
            grantedPermissions: params.grantedPermissions,
            memoryContext,
            conversationHistory: params.conversationHistory,
        };

        return [
            "node",
            "/app/runner.js",
            "--payload",
            JSON.stringify(payload),
        ];
    }
}

// =============================================================================
// Singleton
// =============================================================================

let engineInstance: SandboxExecutionEngine | null = null;

export function getSandboxEngine(): SandboxExecutionEngine {
    if (!engineInstance) {
        engineInstance = new SandboxExecutionEngine();
    }
    return engineInstance;
}
