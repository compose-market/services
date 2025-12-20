/**
 * MCP Registry Sync Script
 * 
 * Fetches MCP servers from the Official MCP Registry API.
 * Extracts catalog metadata: name, repo, packages, transport type.
 * 
 * NOTE: Tools metadata is NOT extracted here - that happens at runtime
 * when servers are actually spawned and queried via JSON-RPC.
 * 
 * Output: mcp/src/data/registryMcp.json
 * 
 * Run with: npx tsx scripts/sync-mcp-registry.ts
 */
import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";
import {
    validateGitHubRepoUrl,
    cleanServerName,
    buildNpmPackageInfo,
    buildDockerPackageInfo,
    type PackageInfo
} from "./lib/metadata-extractor.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MCP_REGISTRY_API = "https://registry.modelcontextprotocol.io/v0/servers";
// Output path - CANONICAL LOCATION: backend/services/connector/data/
const OUTPUT_PATH = path.resolve(__dirname, "../data/registryMcp.json");

// =============================================================================
// Types
// =============================================================================

export interface McpServer {
    id: string;
    name: string;
    namespace: string;
    slug: string;
    description?: string;
    attributes?: string[];
    repository?: { url?: string | null; source?: string };
    spdxLicense?: { name?: string; url?: string } | null;
    url?: string;
    environmentVariablesJsonSchema?: Record<string, unknown> | null;
    transport?: "stdio" | "http";
    image?: string;
    remoteUrl?: string;
    packages?: PackageInfo[];
    remotes?: Array<{
        type: string;
        url: string;
    }>;
    source: "mcp-registry";
    [key: string]: unknown;
}

interface McpRegistryServer {
    server: {
        $schema?: string;
        name: string;
        description?: string;
        title?: string;
        version: string;
        repository?: {
            url?: string;
            source?: string;
        };
        packages?: Array<{
            registryType: string;
            identifier: string;
            version?: string;
            transport?: { type: string };
            environmentVariables?: Array<{
                name: string;
                description?: string;
                isSecret?: boolean;
            }>;
        }>;
        remotes?: Array<{
            type: string;
            url: string;
        }>;
        websiteUrl?: string;
        license?: {
            name?: string;
            url?: string;
        };
    };
    _meta?: {
        "io.modelcontextprotocol.registry/official"?: {
            status: string;
            publishedAt: string;
            updatedAt: string;
            isLatest: boolean;
        };
    };
}

interface McpRegistryApiResponse {
    servers: McpRegistryServer[];
    metadata: {
        nextCursor?: string;
        count: number;
    };
}

export interface RegistryData {
    source: "mcp-registry";
    updatedAt: string;
    count: number;
    servers: McpServer[];
}

// =============================================================================
// API Fetching
// =============================================================================

async function fetchMcpRegistryPage(cursor?: string): Promise<McpRegistryApiResponse> {
    const url = cursor
        ? `${MCP_REGISTRY_API}?cursor=${encodeURIComponent(cursor)}`
        : MCP_REGISTRY_API;

    const res = await fetch(url);

    if (!res.ok) {
        throw new Error(`MCP Registry API error: ${res.status} ${res.statusText}`);
    }

    return res.json() as Promise<McpRegistryApiResponse>;
}

async function fetchMcpRegistryServers(): Promise<McpServer[]> {
    console.log("Fetching from Official MCP Registry...");

    const allServers: McpServer[] = [];
    let cursor: string | undefined;
    let pageNum = 1;

    while (true) {
        process.stdout.write(`\r  Page ${pageNum}...`);

        const response = await fetchMcpRegistryPage(cursor);

        // Process each server from the registry
        for (const item of response.servers) {
            const s = item.server;
            const meta = item._meta?.["io.modelcontextprotocol.registry/official"];

            // ========================================================================
            // CRITICAL: Use actual name field from metadata
            // ========================================================================
            const actualName = cleanServerName(s.title || s.name);

            // Extract namespace and slug from name (format: "namespace/slug")
            const nameParts = s.name.split("/");
            const namespace = nameParts.length > 1 ? nameParts[0] : "unknown";
            const slug = nameParts.length > 1 ? nameParts.slice(1).join("-") : s.name.replace(/[^a-z0-9-]/gi, "-");

            // Generate unique ID
            const id = `mcp-registry-${namespace}-${slug}-${s.version}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");

            // ========================================================================
            // Determine transport type and containerization requirements
            // ========================================================================
            let transport: "stdio" | "http" = "stdio";
            let remoteUrl: string | undefined;
            const hasRemotes = s.remotes && s.remotes.length > 0;

            if (hasRemotes) {
                transport = "http";
                remoteUrl = s.remotes[0].url;
            }

            // Check if server has existing Docker/OCI image
            const hasDockerImage = s.packages?.some(p =>
                p.registryType === 'oci' || p.registryType === 'docker'
            ) || false;

            // Check if npm-only (no repo, just npm package - can use npx directly)
            const isNpmOnly = s.packages?.some(p =>
                p.registryType === 'npm' || p.registryType === 'npmjs'
            ) && !s.repository?.url;

            // Build attributes with proper transport and containerization markers
            const attributes: string[] = [];

            // Transport markers
            if (transport === "http" || hasRemotes) {
                attributes.push("hosting:remote-capable");
            } else {
                attributes.push("hosting:stdio");
            }

            // Status markers
            if (meta?.isLatest) {
                attributes.push("version:latest");
            }
            if (meta?.status === "active") {
                attributes.push("status:active");
            }

            // Containerization markers
            if (hasDockerImage) {
                attributes.push("has-docker-image");
            }
            if (isNpmOnly) {
                attributes.push("npm-only");
            }

            // ========================================================================
            // Transform packages through standardized builders
            // ========================================================================
            const packages: PackageInfo[] = [];
            if (s.packages) {
                for (const pkg of s.packages) {
                    if (pkg.registryType === "npm" || pkg.registryType === "npmjs") {
                        const npmPkg = buildNpmPackageInfo(pkg.identifier);
                        // Preserve environment variables from API
                        if (pkg.environmentVariables) {
                            npmPkg.spawn = {
                                ...npmPkg.spawn,
                                env: Object.fromEntries(
                                    pkg.environmentVariables
                                        .filter(v => !v.isSecret) // Don't include secrets in spawn config
                                        .map(v => [v.name, ""])   // Empty string as placeholder
                                )
                            };
                        }
                        packages.push(npmPkg);
                    } else if (pkg.registryType === "oci" || pkg.registryType === "docker") {
                        packages.push(buildDockerPackageInfo(pkg.identifier));
                    }
                }
            }

            const server: McpServer = {
                id,
                name: actualName,
                namespace,
                slug,
                description: s.description || `MCP server: ${actualName}`,
                attributes,
                repository: s.repository?.url ? {
                    url: validateGitHubRepoUrl(s.repository.url),
                    source: s.repository.source
                } : s.repository,
                spdxLicense: s.license,
                url: s.websiteUrl,
                environmentVariablesJsonSchema: s.packages?.[0]?.environmentVariables || null,
                transport,
                image: undefined, // Will be populated by build-images.ts
                remoteUrl,
                packages: packages.length > 0 ? packages : undefined,
                remotes: s.remotes,
                source: "mcp-registry",
            };

            allServers.push(server);
        }

        process.stdout.write(`\r  Page ${pageNum}: ${response.servers.length} servers (total: ${allServers.length})`);

        // Check for next page
        if (!response.metadata.nextCursor) {
            break;
        }

        cursor = response.metadata.nextCursor;
        pageNum++;

        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 200));
    }

    console.log("");
    return allServers;
}

// =============================================================================
// Main
// =============================================================================

async function main() {
    console.log("╔══════════════════════════════════════════════════════════════╗");
    console.log("║  MCP Registry Sync (registry.modelcontextprotocol.io)       ║");
    console.log("╚══════════════════════════════════════════════════════════════╝");

    const servers = await fetchMcpRegistryServers();

    // Calculate metadata completeness
    const withRepo = servers.filter(s => s.repository?.url).length;
    const withPackages = servers.filter(s => s.packages && s.packages.length > 0).length;
    const remoteCapable = servers.filter(s => s.transport === "http" || s.remoteUrl).length;
    const stdioOnly = servers.filter(s => s.transport === "stdio").length;

    // Containerization analysis
    const hasDocker = servers.filter(s => s.packages && s.packages.some(p => p.registryType === "oci" || p.registryType === "docker")).length;
    const canUseNpx = servers.filter(s => {
        // Can use npx if has NPM package (regardless of repo)
        const hasNpm = s.packages && s.packages.some(p => p.registryType === "npm" || p.registryType === "npmjs");
        return hasNpm;
    }).length;
    const alreadyRemote = servers.filter(s => s.remotes && s.remotes.length > 0).length;
    const needsContainer = servers.filter(s => {
        const isRemote = s.transport === "http" || (s.remotes && s.remotes.length > 0);
        const hasDockerPkg = s.packages && s.packages.some(p => p.registryType === "oci" || p.registryType === "docker");
        const hasNpmPkg = s.packages && s.packages.some(p => p.registryType === "npm" || p.registryType === "npmjs");

        // Needs containerization if: stdio-only + no Docker/NPM + has repo
        return !isRemote && !hasDockerPkg && !hasNpmPkg && s.repository?.url;
    }).length;

    // Write output
    const registryData: RegistryData = {
        source: "mcp-registry",
        updatedAt: new Date().toISOString(),
        count: servers.length,
        servers,
    };

    await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
    await fs.writeFile(OUTPUT_PATH, JSON.stringify(registryData, null, 2), "utf8");

    // Summary
    console.log("\n╔══════════════════════════════════════════════════════════════╗");
    console.log("║  MCP Registry Sync Complete                                  ║");
    console.log("╠══════════════════════════════════════════════════════════════╣");
    console.log(`║  Total servers: ${servers.length.toString().padEnd(43)}║`);
    console.log(`║  With repository: ${withRepo.toString().padEnd(43)}║`);
    console.log(`║  With packages: ${withPackages.toString().padEnd(43)}║`);
    console.log(`║  Remote-capable (HTTP/SSE): ${remoteCapable.toString().padEnd(29)}║`);
    console.log(`║  Stdio-only: ${stdioOnly.toString().padEnd(47)}║`);
    console.log("╠══════════════════════════════════════════════════════════════╣");
    console.log("║  CONTAINERIZATION REQUIREMENTS                               ║");
    console.log(`║  Already has Docker image: ${hasDocker.toString().padEnd(33)}║`);
    console.log(`║  Can use npx directly: ${canUseNpx.toString().padEnd(37)}║`);
    console.log(`║  Needs containerization: ${needsContainer.toString().padEnd(35)}║`);
    console.log(`║  Already remote (skip): ${alreadyRemote.toString().padEnd(36)}║`);
    console.log("╠══════════════════════════════════════════════════════════════╣");
    console.log(`║  Note: Tools metadata extracted at runtime, not during sync ║`);
    console.log("╠══════════════════════════════════════════════════════════════╣");
    console.log(`║  Output: mcp/src/data/registryMcp.json                       ║`);
    console.log("╚══════════════════════════════════════════════════════════════╝");
}

main().catch((err) => {
    console.error("\nMCP Registry sync failed:", err);
    process.exit(1);
});
