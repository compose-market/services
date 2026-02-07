/**
 * Create Refined Category-Based Server Compilations
 * 
 * Extracts and deduplicates servers by transport type:
 * - npxServers.json: NPM/NPX-callable servers
 * - dockerServers.json: External Docker pullable servers  
 * - httpServers.json: HTTP/SSE/streamable remote servers
 * 
 * Priority when servers have multiple options: NPX > HTTP > Docker
 * 
 * Run: npx tsx scripts/compile-categories.ts
 */
import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";
import { validateGitHubRepoUrl } from "./lib/metadata-extractor.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Input paths
const PULSE_MCP_PATH = path.resolve(__dirname, "../data/raw/pulseMcp.json");
const MCP_SO_PATH = path.resolve(__dirname, "../data/raw/mcpSo.json");
const REGISTRY_MCP_PATH = path.resolve(__dirname, "../data/raw/registryMcp.json");
const GLAMA_PATH = path.resolve(__dirname, "../data/raw/glamaServers.json");

// Output paths
const NPX_OUTPUT = path.resolve(__dirname, "../data/refined/npxServers.json");
const DOCKER_OUTPUT = path.resolve(__dirname, "../data/refined/dockerServers.json");
const HTTP_OUTPUT = path.resolve(__dirname, "../data/refined/httpServers.json");

// =============================================================================
// Types
// =============================================================================

interface McpServer {
    id: string;
    name: string;
    namespace: string;
    slug: string;
    description?: string;
    attributes?: string[];
    repository?: { url?: string | null };
    tools?: Array<{
        name: string;
        description?: string;
        inputSchema?: Record<string, unknown>;
    }>;
    packages?: Array<{
        registryType: string;
        identifier: string;
        version?: string;
        pullCommand?: string;
        installCommand?: string;
        spawn?: {
            command: string;
            args: string[];
        };
    }>;
    transport?: "stdio" | "http";
    image?: string;
    remoteUrl?: string;
    remotes?: Array<{ type: string; url: string }>;
    source: string;
    [key: string]: unknown;
}

interface RegistryData {
    source?: string;
    sources?: string[];
    updatedAt: string;
    count: number;
    servers: McpServer[];
}

// =============================================================================
// Deduplication Logic
// =============================================================================

function getServerDeduplicationKey(server: McpServer): string {
    // PRIMARY: Use repository URL (same repo = same server)
    if (server.repository?.url) {
        const cleanUrl = validateGitHubRepoUrl(server.repository.url);
        if (cleanUrl) {
            const match = cleanUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
            if (match && match[1] && match[2]) {
                return `repo:${match[1]}/${match[2]}`.toLowerCase();
            }
        }
    }

    // SECONDARY: Use actual name field
    if (server.name) {
        const cleanName = server.name.toLowerCase().trim()
            .replace(/^@/, '')
            .replace(/[\s\/]+/g, '-')
            .replace(/[^a-z0-9-]/g, '')
            .replace(/--+/g, '-')
            .replace(/^-+|-+$/g, '');

        if (cleanName) {
            return `name:${cleanName}`;
        }
    }

    // TERTIARY: Use npm package identifier
    if (server.packages && server.packages.length > 0) {
        const npmPkg = server.packages.find(p => p.registryType === 'npm' || p.registryType === 'npmjs');
        if (npmPkg && npmPkg.identifier) {
            return `npm:${npmPkg.identifier.toLowerCase()}`;
        }
    }

    // QUATERNARY: namespace/slug
    const namespace = (server.namespace || "").toLowerCase().trim();
    const slug = (server.slug || "").toLowerCase().trim();
    if (namespace && slug) {
        return `slug:${namespace}/${slug}`;
    }

    return `id:${server.id.toLowerCase()}`;
}

function deduplicateServers(servers: McpServer[]): McpServer[] {
    const byKey = new Map<string, McpServer>();

    for (const server of servers) {
        const key = getServerDeduplicationKey(server);
        const existing = byKey.get(key);

        if (!existing) {
            byKey.set(key, server);
        } else {
            // Prefer sources in priority order: mcp-registry > glama > mcp-so > pulsemcp
            const sourcePriority: Record<string, number> = {
                "mcp-registry": 4,
                "glama": 3,
                "mcp-so": 2,
                "pulsemcp": 1,
            };

            const existingPriority = sourcePriority[existing.source] || 0;
            const newPriority = sourcePriority[server.source] || 0;

            if (newPriority > existingPriority) {
                byKey.set(key, server);
            } else if (newPriority === existingPriority) {
                // Merge metadata
                const merged: McpServer = { ...existing };

                if (server.repository?.url && !existing.repository?.url) {
                    merged.repository = server.repository;
                }

                if (server.packages && server.packages.length > 0 && (!existing.packages || existing.packages.length === 0)) {
                    merged.packages = server.packages;
                }

                if (server.remotes && server.remotes.length > 0 && (!existing.remotes || existing.remotes.length === 0)) {
                    merged.remotes = server.remotes;
                }

                if (server.remoteUrl && !existing.remoteUrl) {
                    merged.remoteUrl = server.remoteUrl;
                }

                if (server.transport && !existing.transport) {
                    merged.transport = server.transport;
                }

                if (server.tools && server.tools.length > 0) {
                    if (!existing.tools || existing.tools.length === 0) {
                        merged.tools = server.tools;
                    } else if (server.tools.length > existing.tools.length) {
                        merged.tools = server.tools;
                    }
                }

                byKey.set(key, merged);
            }
        }
    }

    return Array.from(byKey.values());
}

// =============================================================================
// Category Extraction
// =============================================================================

function hasNPMPackage(server: McpServer): boolean {
    return !!(server.packages?.some(p =>
        p.registryType === 'npm' || p.registryType === 'npmjs'
    ));
}

function hasExternalDocker(server: McpServer): boolean {
    return !!(server.packages?.some(p =>
        (p.registryType === 'oci' || p.registryType === 'docker') &&
        !p.identifier?.includes('ghcr.io/compose-market/mcp')
    ));
}

function hasHTTPRemote(server: McpServer): boolean {
    return !!(
        server.transport === 'http' ||
        server.remoteUrl ||
        (server.remotes && server.remotes.length > 0)
    );
}

// =============================================================================
// Main
// =============================================================================

async function main() {
    console.log("╔══════════════════════════════════════════════════════════════╗");
    console.log("║  Category-Based Server Compilation                          ║");
    console.log("╚══════════════════════════════════════════════════════════════╝");

    console.log("\n[1/5] Loading source data...");

    const sources = [
        { path: PULSE_MCP_PATH, name: "pulsemcp" },
        { path: MCP_SO_PATH, name: "mcp-so" },
        { path: REGISTRY_MCP_PATH, name: "mcp-registry" },
        { path: GLAMA_PATH, name: "glama" }
    ];

    const allServers: McpServer[] = [];

    for (const { path: sourcePath, name } of sources) {
        try {
            const data = await fs.readFile(sourcePath, "utf8");
            const parsed: RegistryData = JSON.parse(data);
            console.log(`  ✓ Loaded ${parsed.servers.length} servers from ${name}`);
            allServers.push(...parsed.servers);
        } catch (error) {
            console.warn(`  ⚠ Could not load ${name}: ${error}`);
        }
    }

    console.log(`  Total servers loaded: ${allServers.length}`);

    console.log("\n[2/5] Categorizing servers...");

    // Categorize with priority: NPX > HTTP > Docker
    const npxServers: McpServer[] = [];
    const httpServers: McpServer[] = [];
    const dockerServers: McpServer[] = [];

    for (const server of allServers) {
        const hasNPM = hasNPMPackage(server);
        const hasHTTP = hasHTTPRemote(server);
        const hasDocker = hasExternalDocker(server);

        // Priority: NPX > HTTP > Docker
        if (hasNPM) {
            npxServers.push(server);
        } else if (hasHTTP) {
            httpServers.push(server);
        } else if (hasDocker) {
            dockerServers.push(server);
        }
    }

    console.log(`  NPM/NPX servers: ${npxServers.length}`);
    console.log(`  HTTP/SSE servers: ${httpServers.length}`);
    console.log(`  External Docker servers: ${dockerServers.length}`);

    console.log("\n[3/5] Deduplicating...");

    const dedupedNPX = deduplicateServers(npxServers);
    const dedupedHTTP = deduplicateServers(httpServers);
    const dedupedDocker = deduplicateServers(dockerServers);

    console.log(`  NPM/NPX (after dedup): ${dedupedNPX.length} (-${npxServers.length - dedupedNPX.length})`);
    console.log(`  HTTP/SSE (after dedup): ${dedupedHTTP.length} (-${httpServers.length - dedupedHTTP.length})`);
    console.log(`  Docker (after dedup): ${dedupedDocker.length} (-${dockerServers.length - dedupedDocker.length})`);

    console.log("\n[4/5] Calculating statistics...");

    // NPX stats
    const npxWithTools = dedupedNPX.filter(s => s.tools && s.tools.length > 0).length;
    const npxWithRepo = dedupedNPX.filter(s => s.repository?.url).length;

    // HTTP stats
    const httpWithTools = dedupedHTTP.filter(s => s.tools && s.tools.length > 0).length;
    const httpWithRepo = dedupedHTTP.filter(s => s.repository?.url).length;

    // Docker stats
    const dockerWithTools = dedupedDocker.filter(s => s.tools && s.tools.length > 0).length;
    const dockerWithRepo = dedupedDocker.filter(s => s.repository?.url).length;

    console.log("\n[5/5] Writing outputs...");

    // Write NPX servers
    await fs.writeFile(
        NPX_OUTPUT,
        JSON.stringify({
            sources: ["pulsemcp", "mcp-so", "mcp-registry", "glama"],
            category: "npm-npx",
            updatedAt: new Date().toISOString(),
            count: dedupedNPX.length,
            servers: dedupedNPX
        }, null, 2)
    );
    console.log(`  ✓ Written: npxServers.json`);

    // Write HTTP servers
    await fs.writeFile(
        HTTP_OUTPUT,
        JSON.stringify({
            sources: ["pulsemcp", "mcp-so", "mcp-registry", "glama"],
            category: "http-sse",
            updatedAt: new Date().toISOString(),
            count: dedupedHTTP.length,
            servers: dedupedHTTP
        }, null, 2)
    );
    console.log(`  ✓ Written: httpServers.json`);

    // Write Docker servers
    await fs.writeFile(
        DOCKER_OUTPUT,
        JSON.stringify({
            sources: ["pulsemcp", "mcp-so", "mcp-registry", "glama"],
            category: "external-docker",
            updatedAt: new Date().toISOString(),
            count: dedupedDocker.length,
            servers: dedupedDocker
        }, null, 2)
    );
    console.log(`  ✓ Written: dockerServers.json`);

    // Summary
    console.log("\n╔══════════════════════════════════════════════════════════════╗");
    console.log("║  Category Compilation Complete                               ║");
    console.log("╠══════════════════════════════════════════════════════════════╣");
    console.log(`║  NPM/NPX SERVERS: ${dedupedNPX.length.toString().padEnd(43)}║`);
    console.log(`║    With tools: ${npxWithTools.toString().padEnd(46)}║`);
    console.log(`║    With repository: ${npxWithRepo.toString().padEnd(41)}║`);
    console.log("╠══════════════════════════════════════════════════════════════╣");
    console.log(`║  HTTP/SSE SERVERS: ${dedupedHTTP.length.toString().padEnd(42)}║`);
    console.log(`║    With tools: ${httpWithTools.toString().padEnd(46)}║`);
    console.log(`║    With repository: ${httpWithRepo.toString().padEnd(41)}║`);
    console.log("╠══════════════════════════════════════════════════════════════╣");
    console.log(`║  EXTERNAL DOCKER SERVERS: ${dedupedDocker.length.toString().padEnd(35)}║`);
    console.log(`║    With tools: ${dockerWithTools.toString().padEnd(46)}║`);
    console.log(`║    With repository: ${dockerWithRepo.toString().padEnd(41)}║`);
    console.log("╚══════════════════════════════════════════════════════════════╝");
}

main().catch((err) => {
    console.error("\nCategory compilation failed:", err);
    process.exit(1);
});
