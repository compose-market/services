/**
 * PulseMCP Server Sync Script
 * 
 * Scrapes MCP servers from PulseMCP website and individual server pages.
 * Extracts complete metadata including name, tools, packages, and transport types.
 * 
 * Output: mcp/src/data/pulseMcp.json
 * 
 * Run with: npx tsx scripts/sync-pulsemcp.ts
 */
import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";
import {
    validateGitHubRepoUrl,
    extractNameFromHtml,
    extractGitHubRepo,
    extractNpmPackageFromGlamaHtml,
    extractDockerImageFromGlamaHtml,
    extractAllToolsMetadata,
    extractRemoteServerUrl,
    extractRemoteUrlFromServerJson,
    extractNpmFromPackageJson,
    extractNpmPackageFromReadme,
    extractDockerImageFromReadme,
    determineTransport,
    hasExistingDockerImage,
    isNpmOnly,
    extractDescription,
    cleanServerName,
    buildNpmPackageInfo,
    buildDockerPackageInfo,
    isFromRegistryOrigin,
    type PackageInfo
} from "./lib/metadata-extractor.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PULSEMCP_BASE = "https://www.pulsemcp.com";
// Output path - CANONICAL LOCATION: backend/services/connector/data/
const OUTPUT_PATH = path.resolve(__dirname, "../data/pulseMcp.json");
const REQUEST_DELAY = 100; // ms between requests

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
    repository?: { url?: string | null };
    tools?: Array<{
        name: string;
        description?: string;
        inputSchema?: Record<string, unknown>;
    }>;
    packages?: PackageInfo[];
    transport?: "stdio" | "http";
    remoteUrl?: string;
    source: "pulsemcp";
    [key: string]: unknown;
}

export interface RegistryData {
    source: "pulsemcp";
    updatedAt: string;
    count: number;
    servers: McpServer[];
}

// =============================================================================
// PulseMCP Scraping
// =============================================================================

async function fetchPulseMCPPage(page: number): Promise<{ servers: McpServer[], hasNextPage: boolean }> {
    const res = await fetch(`${PULSEMCP_BASE}/servers?page=${page}`);

    if (!res.ok) {
        throw new Error(`PulseMCP page ${page} error: ${res.status} ${res.statusText}`);
    }

    const html = await res.text();

    const servers: McpServer[] = [];

    // Extract server links from the page
    const serverLinkRegex = /href="\/servers\/([^"]+)"/g;
    const matches = [...html.matchAll(serverLinkRegex)];

    for (const match of matches) {
        const [, serverSlug] = match;

        // Skip navigational links
        if (serverSlug.includes('?') || serverSlug === 'servers') continue;

        // Rate limiting for individual server pages
        await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY));

        try {
            const serverPageRes = await fetch(`${PULSEMCP_BASE}/servers/${serverSlug}`);
            if (!serverPageRes.ok) continue;

            const serverPageHtml = await serverPageRes.text();

            // ===================================================================
            // CRITICAL: Extract server.json if available (for remotes)
            // ===================================================================
            let serverJsonData: any = null;
            const hasServerJson = serverPageHtml.includes('View server.json file');

            if (hasServerJson) {
                try {
                    const serverJsonRes = await fetch(`${PULSEMCP_BASE}/servers/${serverSlug}/serverjson`);
                    if (serverJsonRes.ok) {
                        const serverJsonHtml = await serverJsonRes.text();
                        // Extract JSON from the page (it's in a code block or script)
                        const jsonMatch = serverJsonHtml.match(/<code[^>]*>([\s\S]*?)<\/code>/i) ||
                            serverJsonHtml.match(/const\s+serverJson\s*=\s*({[\s\S]*?});/);
                        if (jsonMatch) {
                            const cleanJson = jsonMatch[1]
                                .replace(/<[^>]+>/g, '')
                                .replace(/&quot;/g, '"')
                                .replace(/&lt;/g, '<')
                                .replace(/&gt;/g, '>')
                                .replace(/&amp;/g, '&')
                                .trim();
                            serverJsonData = JSON.parse(cleanJson);
                        }
                    }
                } catch (e) {
                    // server.json not parseable, continue
                }
            }

            // Extract GitHub repository and validate
            const repoUrl = extractGitHubRepo(serverPageHtml);

            // ===================================================================
            // CRITICAL: Follow GitHub repo to get package.json (try multiple branches)
            // ===================================================================
            let packageJsonData: any = null;
            if (repoUrl) {
                // ================================================================
                // CRITICAL: Skip if from modelcontextprotocol registry origin
                // (we already have these from primary Registry MCP source)
                // ================================================================
                if (isFromRegistryOrigin(repoUrl)) {
                    continue; // Skip registry duplicates
                }

                try {
                    // Try main, master, and HEAD branches
                    const branches = ['main', 'master', 'HEAD'];
                    for (const branch of branches) {
                        const packageJsonUrl = repoUrl
                            .replace('github.com', 'raw.githubusercontent.com')
                            .replace(/\.git$/, '') + `/${branch}/package.json`;

                        const pkgRes = await fetch(packageJsonUrl);
                        if (pkgRes.ok) {
                            packageJsonData = await pkgRes.json();
                            break;
                        }
                    }
                } catch (e) {
                    // package.json not available
                }
            }

            // ===================================================================
            // CRITICAL: Extract actual server name from page
            // ===================================================================
            const actualName = cleanServerName(extractNameFromHtml(serverPageHtml, serverSlug));

            // Extract description
            const description = extractDescription(serverPageHtml, `MCP server: ${actualName}`);

            // Extract namespace from GitHub URL or use slug
            let namespace = "unknown";
            let slug = serverSlug;

            if (repoUrl) {
                const match = repoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
                if (match && match[1] && match[2]) {
                    namespace = match[1];
                    slug = match[2].replace(/\.git$/, '');
                }
            }

            // ================================================================
            // CRITICAL: Extract packages from server.json and package.json
            // ================================================================
            const packages: PackageInfo[] = [];

            // 1. Check server.json for remotes (HTTP servers)
            let remoteUrl: string | null = null;
            if (serverJsonData) {
                remoteUrl = extractRemoteUrlFromServerJson(serverJsonData) ?? null;
            }

            // 2. Extract NPM package from package.json
            if (packageJsonData) {
                const npmPackage = extractNpmFromPackageJson(packageJsonData);
                if (npmPackage) {
                    packages.push(buildNpmPackageInfo(npmPackage));
                }
            }

            // 3. Fallback: Try extracting from HTML
            if (packages.length === 0) {
                const npmPackage = extractNpmPackageFromGlamaHtml(serverPageHtml) || extractNpmPackageFromReadme(serverPageHtml);
                const dockerImage = extractDockerImageFromGlamaHtml(serverPageHtml) || extractDockerImageFromReadme(serverPageHtml);
                if (npmPackage) packages.push(buildNpmPackageInfo(npmPackage));
                if (dockerImage) packages.push(buildDockerPackageInfo(dockerImage));
            }

            // ===================================================================
            // CRITICAL: Extract tools metadata from HTML
            // ===================================================================
            const tools = extractAllToolsMetadata(serverPageHtml);

            // Extract transport and remote URL
            const transport = determineTransport(false, remoteUrl || extractRemoteServerUrl(serverPageHtml));

            // Build attributes
            const attributes: string[] = [];
            const isRemote = serverPageHtml.includes('Remote Available') || serverPageHtml.includes('remote') || !!remoteUrl;
            if (transport === "http" || remoteUrl || isRemote) {
                attributes.push("hosting:remote-capable");
            } else if (transport === "stdio") {
                attributes.push("hosting:stdio");
            }

            const id = `pulsemcp-${namespace}-${slug}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");

            const server: McpServer = {
                id,
                name: actualName,
                namespace,
                slug,
                description,
                attributes,
                repository: repoUrl ? { url: repoUrl } : undefined,
                packages,
                tools,
                transport,
                remoteUrl: remoteUrl || undefined,  // Include remote URL for HTTP servers
                source: "pulsemcp",
            };
            servers.push(server);
        } catch (error) {
            // Skip failed servers
        }
    }

    // Check if there's a next page
    const hasNextPage = html.includes('Next') || html.includes(`page=${page + 1}`);

    return { servers, hasNextPage };
}

async function fetchPulseMcpServers(): Promise<McpServer[]> {
    console.log("Fetching from PulseMCP...");

    const allServers: McpServer[] = [];
    let page = 1;

    while (true) {
        // Rate limiting before each page
        if (page > 1) {
            await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY));
        }

        const response = await fetchPulseMCPPage(page);

        for (const server of response.servers) {
            allServers.push(server);
        }

        process.stdout.write(`\r  Page ${page}: ${response.servers.length} servers (total: ${allServers.length})`);

        if (!response.hasNextPage || page >= 200) {
            break;
        }

        page++;
    }

    console.log("");
    return allServers;
}

// =============================================================================
// Main
// =============================================================================

async function main() {
    console.log("╔══════════════════════════════════════════════════════════════╗");
    console.log("║  PulseMCP MCP Server Sync                                    ║");
    console.log("╚══════════════════════════════════════════════════════════════╝");

    const servers = await fetchPulseMcpServers();

    // Calculate metadata completeness
    const withTools = servers.filter(s => s.tools && s.tools.length > 0).length;
    const withRepo = servers.filter(s => s.repository?.url).length;
    const withPackages = servers.filter(s => s.packages && s.packages.length > 0).length;
    const remoteCapable = servers.filter(s => s.transport === "http" || s.remoteUrl).length;
    const stdioOnly = servers.filter(s => s.transport === "stdio").length;

    // Containerization analysis
    const hasDockerImage = servers.filter(s => s.packages && s.packages.some(p => p.registryType === "oci" || p.registryType === "docker")).length;
    const canUseNpx = servers.filter(s => {
        // Can use npx if has NPM package (regardless of repo)
        const hasNpm = s.packages && s.packages.some(p => p.registryType === "npm" || p.registryType === "npmjs");
        return hasNpm;
    }).length;
    const alreadyRemote = servers.filter(s => s.remoteUrl || s.transport === "http").length;
    const needsContainerization = servers.filter(s => {
        const isRemote = s.transport === "http" || s.remoteUrl;
        const hasDocker = s.packages && s.packages.some(p => p.registryType === "oci" || p.registryType === "docker");
        const hasNpm = s.packages && s.packages.some(p => p.registryType === "npm" || p.registryType === "npmjs");

        // Needs containerization if: stdio-only + no Docker/NPM + has repo
        return !isRemote && !hasDocker && !hasNpm && s.repository?.url;
    }).length;

    // Write output
    const registryData: RegistryData = {
        source: "pulsemcp",
        updatedAt: new Date().toISOString(),
        count: servers.length,
        servers,
    };

    await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
    await fs.writeFile(OUTPUT_PATH, JSON.stringify(registryData, null, 2), "utf8");

    // Summary
    console.log("\n╔══════════════════════════════════════════════════════════════╗");
    console.log("║  PulseMCP Sync Complete                                      ║");
    console.log("╠══════════════════════════════════════════════════════════════╣");
    console.log(`║  Total servers: ${servers.length.toString().padEnd(45)}║`);
    console.log(`║  With tools metadata: ${withTools.toString().padEnd(39)}║`);
    console.log(`║  With repository: ${withRepo.toString().padEnd(43)}║`);
    console.log(`║  With packages: ${withPackages.toString().padEnd(45)}║`);
    console.log(`║  Remote-capable (HTTP/SSE): ${remoteCapable.toString().padEnd(33)}║`);
    console.log(`║  Stdio-only: ${stdioOnly.toString().padEnd(48)}║`);
    console.log("╠══════════════════════════════════════════════════════════════╣");
    console.log("║  CONTAINERIZATION REQUIREMENTS                               ║");
    console.log(`║  Already has Docker image: ${hasDockerImage.toString().padEnd(34)}║`);
    console.log(`║  Can use npx directly: ${canUseNpx.toString().padEnd(38)}║`);
    console.log(`║  Needs containerization: ${needsContainerization.toString().padEnd(36)}║`);
    console.log(`║  Already remote (skip): ${alreadyRemote.toString().padEnd(37)}║`);
    console.log("╠══════════════════════════════════════════════════════════════╣");
    console.log(`║  Output: mcp/src/data/pulseMcp.json                          ║`);
    console.log("╚══════════════════════════════════════════════════════════════╝");
}

main().catch((err) => {
    console.error("\nPulseMCP sync failed:", err);
    process.exit(1);
});
