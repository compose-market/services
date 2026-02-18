/**
 * Sandbox Service - Docker-based Isolation
 * 
 * Rebuild of backend/services/sandbox with:
 * - Full Docker container isolation
 * - Security-hardened configuration (OpenClaw patterns)
 * - Resource limits (CPU, memory, PIDs)
 * - Network isolation
 * - Memory and Backpack integration
 */

import Docker from "dockerode";
import * as fs from "fs";
import * as path from "path";

// =============================================================================
// Types
// =============================================================================

export interface SandboxConfig {
    sessionKey: string;
    agentWallet: string;
    framework: "langchain" | "openclaw";
    workspaceDir?: string;
    workspaceAccess: "none" | "ro" | "rw";
    networkAllow?: string[];
    resourceLimits?: ResourceLimits;
    env?: Record<string, string>;
}

export interface ResourceLimits {
    memory?: number;      // Bytes
    cpuShares?: number;   // 0-1024
    pidsLimit?: number;
    timeoutMs?: number;
}

export interface ContainerInfo {
    id: string;
    name: string;
    status: "running" | "exited" | "paused" | "unknown";
    createdAt: number;
}

export interface ExecutionResult {
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
    duration: number;
}

// =============================================================================
// Security Constants
// =============================================================================

const BLOCKED_HOST_PATHS = [
    "/etc",
    "/private/etc",
    "/proc",
    "/sys",
    "/dev",
    "/root",
    "/boot",
    "/run",
    "/var/run",
    "/private/var/run",
    "/var/run/docker.sock",
    "/run/docker.sock",
    "/.dockerenv",
];

const BLOCKED_NETWORK_MODES = new Set(["host"]);
const BLOCKED_SECCOMP_PROFILES = new Set(["unconfined"]);
const BLOCKED_APPARMOR_PROFILES = new Set(["unconfined"]);

// =============================================================================
// Docker Manager
// =============================================================================

export class SandboxDockerManager {
    private docker: Docker;
    private containers: Map<string, Docker.Container> = new Map();
    
    constructor() {
        const socketPath = process.env.DOCKER_SOCKET || "/var/run/docker.sock";
        
        this.docker = new Docker({
            socketPath: fs.existsSync(socketPath) ? socketPath : undefined,
            host: process.env.DOCKER_HOST,
            port: process.env.DOCKER_PORT ? parseInt(process.env.DOCKER_PORT, 10) : undefined,
        });
    }
    
    // -------------------------------------------------------------------------
    // Container Lifecycle
    // -------------------------------------------------------------------------
    
    async createSandbox(params: SandboxConfig): Promise<string> {
        const containerName = `sandbox-${params.sessionKey}`;
        
        // Check if container already exists
        const existing = this.containers.get(containerName);
        if (existing) {
            try {
                const info = await existing.inspect();
                if (info.State.Running) {
                    return containerName;
                }
            } catch {
                // Container doesn't exist, continue
            }
        }
        
        // Build host config with security hardening
        const hostConfig = this.buildHostConfig(params);
        
        // Validate security configuration
        this.validateSecurity(hostConfig);
        
        // Build environment
        const env = this.buildEnvVars(params);
        
        // Create container
        const container = await this.docker.createContainer({
            name: containerName,
            Image: `compose/agent-${params.framework}:latest`,
            Env: env,
            HostConfig: hostConfig,
            Tty: true,
            AttachStdin: true,
            AttachStdout: true,
            AttachStderr: true,
            OpenStdin: true,
        });
        
        // Start container
        await container.start();
        
        // Cache container
        this.containers.set(containerName, container);
        
        return containerName;
    }
    
    async destroySandbox(containerName: string): Promise<void> {
        const container = this.containers.get(containerName);
        
        if (container) {
            try {
                await container.stop({ t: 5 });
                await container.remove({ force: true });
            } catch (error) {
                console.error("[sandbox] Error destroying container:", error);
            }
            
            this.containers.delete(containerName);
        } else {
            // Try to find and remove by name
            try {
                const container = this.docker.getContainer(containerName);
                await container.stop({ t: 5 });
                await container.remove({ force: true });
            } catch {
                // Container doesn't exist
            }
        }
    }
    
    async getContainerInfo(containerName: string): Promise<ContainerInfo | null> {
        const container = this.containers.get(containerName) || 
            this.docker.getContainer(containerName);
        
        try {
            const info = await container.inspect();
            
            return {
                id: info.Id,
                name: info.Name.replace(/^\//, ""),
                status: info.State.Running ? "running" :
                         info.State.Paused ? "paused" :
                         info.State.ExitCode !== undefined ? "exited" : "unknown",
                createdAt: Number.isFinite(Date.parse(info.Created)) ? Date.parse(info.Created) : Date.now(),
            };
        } catch {
            return null;
        }
    }
    
    async listSandboxes(): Promise<ContainerInfo[]> {
        const containers = await this.docker.listContainers({
            all: true,
            filters: {
                name: ["sandbox-"],
            },
        });
        
        return containers.map(c => ({
            id: c.Id,
            name: c.Names[0]?.replace(/^\//, "") || "",
            status: c.State as ContainerInfo["status"],
            createdAt: (c.Created || Math.floor(Date.now() / 1000)) * 1000,
        }));
    }
    
    // -------------------------------------------------------------------------
    // Execution
    // -------------------------------------------------------------------------
    
    async executeInSandbox(
        containerName: string,
        command: string[],
        timeoutMs?: number
    ): Promise<ExecutionResult> {
        const container = this.containers.get(containerName) ||
            this.docker.getContainer(containerName);
        
        const startTime = Date.now();
        
        try {
            const exec = await container.exec({
                Cmd: command,
                AttachStdout: true,
                AttachStderr: true,
                Tty: false,
            });
            
            const stream = await exec.start({
                Detach: false,
                Tty: false,
            });
            
            // Collect output with timeout
            const stdout: string[] = [];
            const stderr: string[] = [];
            
            const timeout = timeoutMs || 60000;
            const timeoutPromise = new Promise<never>((_, reject) => {
                setTimeout(() => reject(new Error("Execution timeout")), timeout);
            });
            
            await Promise.race([
                (async () => {
                    // Parse multiplexed stream
                    const { parseStream } = await import("./stream-parser.js");
                    for await (const chunk of parseStream(stream)) {
                        if (chunk.type === "stdout") {
                            stdout.push(chunk.data);
                        } else {
                            stderr.push(chunk.data);
                        }
                    }
                })(),
                timeoutPromise,
            ]);
            
            // Get exit code
            const inspect = await exec.inspect();
            
            return {
                success: inspect.ExitCode === 0,
                stdout: stdout.join(""),
                stderr: stderr.join(""),
                exitCode: inspect.ExitCode || 0,
                duration: Date.now() - startTime,
            };
        } catch (error) {
            return {
                success: false,
                stdout: "",
                stderr: error instanceof Error ? error.message : "Unknown error",
                exitCode: 1,
                duration: Date.now() - startTime,
            };
        }
    }
    
    // -------------------------------------------------------------------------
    // Private Helpers
    // -------------------------------------------------------------------------
    
    private buildHostConfig(params: SandboxConfig): Docker.ContainerCreateOptions["HostConfig"] {
        const config: Docker.ContainerCreateOptions["HostConfig"] = {
            // Read-only root filesystem
            ReadonlyRootfs: true,
            
            // Temporary filesystems
            Tmpfs: {
                "/tmp": "size=100m,mode=1777",
                "/var/tmp": "size=50m,mode=1777",
                "/run": "size=10m,mode=1777",
            },
            
            // Network isolation
            NetworkMode: params.networkAllow && params.networkAllow.length > 0
                ? "compose-sandbox-network"
                : "none",
            
            // Drop all capabilities
            CapDrop: ["ALL"],
            
            // Security options
            SecurityOpt: [
                "no-new-privileges",
                "seccomp=default",
            ],
            
            // Resource limits
            Memory: params.resourceLimits?.memory || 512 * 1024 * 1024,
            MemorySwap: params.resourceLimits?.memory || 512 * 1024 * 1024,
            CpuShares: params.resourceLimits?.cpuShares || 512,
            PidsLimit: params.resourceLimits?.pidsLimit || 256,
        };
        
        // Workspace mount (controlled access)
        if (params.workspaceDir && params.workspaceAccess !== "none") {
            config.Binds = [
                `${params.workspaceDir}:/workspace:${params.workspaceAccess}`,
            ];
        }
        
        return config;
    }
    
    private buildEnvVars(params: SandboxConfig): string[] {
        const env: Record<string, string> = {
            AGENT_WALLET: params.agentWallet,
            SESSION_KEY: params.sessionKey,
            FRAMEWORK: params.framework,
            
            // API Keys from environment
            COMPOSIO_API_KEY: process.env.COMPOSIO_API_KEY || "",
            MEM0_API_KEY: process.env.MEM0_API_KEY || "",
            REDIS_URL: process.env.REDIS_DATABASE_PUBLIC_ENDPOINT || "",
            REDIS_PASSWORD: process.env.REDIS_DEFAULT_PASSWORD || "",
            
            // Cloudflare
            CF_API_TOKEN: process.env.CF_API_TOKEN || "",
            CF_ACCOUNT_ID: process.env.CF_ACCOUNT_ID || "",
            
            // Ollama
            OLLAMA_AZURE_URL: process.env.OLLAMA_AZURE_URL || "",
            
            // Custom env
            ...params.env,
        };
        
        return Object.entries(env)
            .filter(([, value]) => value !== undefined && value !== "")
            .map(([key, value]) => `${key}=${value}`);
    }
    
    private validateSecurity(hostConfig: Docker.ContainerCreateOptions["HostConfig"]): void {
        // Validate binds (no blocked paths)
        for (const bind of hostConfig?.Binds || []) {
            const [hostPath] = bind.split(":");
            
            let resolvedPath: string;
            try {
                resolvedPath = fs.realpathSync(hostPath);
            } catch {
                throw new SecurityError(`Host path does not exist: ${hostPath}`);
            }
            
            for (const blocked of BLOCKED_HOST_PATHS) {
                if (resolvedPath.startsWith(blocked)) {
                    throw new SecurityError(`Blocked host path: ${hostPath} resolves to ${resolvedPath}`);
                }
            }
        }
        
        // Validate network mode
        if (hostConfig?.NetworkMode && BLOCKED_NETWORK_MODES.has(hostConfig.NetworkMode)) {
            throw new SecurityError(`Blocked network mode: ${hostConfig.NetworkMode}`);
        }
        
        // Validate security profiles
        for (const opt of hostConfig?.SecurityOpt || []) {
            if (opt.startsWith("seccomp=")) {
                const profile = opt.slice(8);
                if (BLOCKED_SECCOMP_PROFILES.has(profile)) {
                    throw new SecurityError(`Blocked seccomp profile: ${profile}`);
                }
            }
            if (opt.startsWith("apparmor=")) {
                const profile = opt.slice(9);
                if (BLOCKED_APPARMOR_PROFILES.has(profile)) {
                    throw new SecurityError(`Blocked apparmor profile: ${profile}`);
                }
            }
        }
    }
    
    // -------------------------------------------------------------------------
    // Cleanup
    // -------------------------------------------------------------------------
    
    async cleanupIdleSandboxes(maxAgeMs: number = 30 * 60 * 1000): Promise<number> {
        const containers = await this.listSandboxes();
        let cleaned = 0;
        
        for (const info of containers) {
            if (info.status === "exited") {
                const age = Date.now() - info.createdAt;
                if (age > maxAgeMs) {
                    await this.destroySandbox(info.name);
                    cleaned++;
                }
            }
        }
        
        return cleaned;
    }
}

// =============================================================================
// Security Error
// =============================================================================

export class SecurityError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SecurityError";
    }
}

// =============================================================================
// Stream Parser (for multiplexed Docker streams)
// =============================================================================

// Will be imported from separate file, but provide inline fallback
async function* parseStreamFallback(stream: NodeJS.ReadableStream): AsyncGenerator<{ type: "stdout" | "stderr"; data: string }> {
    const { promisify } = await import("util");
    const { once } = await import("events");
    
    let buffer = Buffer.alloc(0);
    
    stream.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
    });
    
    await once(stream, "end");
    
    // Parse multiplexed stream (8-byte header + payload)
    let offset = 0;
    while (offset < buffer.length) {
        if (offset + 8 > buffer.length) break;
        
        const header = buffer.slice(offset, offset + 8);
        const streamType = header[0];
        const size = header.readUInt32BE(4);
        
        offset += 8;
        
        if (offset + size > buffer.length) break;
        
        const payload = buffer.slice(offset, offset + size).toString("utf-8");
        offset += size;
        
        yield {
            type: streamType === 1 ? "stdout" : "stderr",
            data: payload,
        };
    }
}

// Write stream parser module
import * as stream from "stream";

export { parseStreamFallback as parseStream };
