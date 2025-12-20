/**
 * Glama.ai MCP Server Sync Script
 * 
 * Scrapes MCP servers from Glama.ai sitemap and individual server pages.
 * Extracts complete metadata including name, tools, packages, and transport types.
 * 
 * Output: mcp/src/data/glamaServers.json
 * 
 * Run with: npx tsx scripts/sync-glama.ts
 */
import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";
import {
    validateGitHubRepoUrl,
    extractNameFromHtml,
    extractGitHubRepo,
    extractGitHubRepoFromGlamaResources,
    extractNpmPackageFromGlamaHtml,
    extractDockerImageFromGlamaHtml,
    extractToolsFromGlamaHtml,
    extractRemoteServerUrl,
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
    extractTransportHintsFromReadme,
    isFromRegistryOrigin,
    type PackageInfo,
    type Tool
} from "./lib/metadata-extractor.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GLAMA_SITEMAP_URL = "https://glama.ai/sitemaps/mcp-servers.xml";
// Output path - CANONICAL LOCATION: backend/services/connector/data/
const OUTPUT_PATH = path.resolve(__dirname, "../data/glamaServers.json");
const REQUEST_DELAY = 100; // ms between requests
const CONCURRENCY = 10;

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
    source: "glama";
    [key: string]: unknown;
}

export interface RegistryData {
    source: "glama";
    updatedAt: string;
    count: number;
    servers: McpServer[];
}

// =============================================================================
// Glama.ai Scraping
// =============================================================================

async function fetchGlamaServers(): Promise<McpServer[]> {
    console.log("Fetching from Glama.ai...");

    const allServers: McpServer[] = [];

    try {
        // Fetch the sitemap XML
        const res = await fetch(GLAMA_SITEMAP_URL);

        if (!res.ok) {
            throw new Error(`Glama sitemap error: ${res.status} ${res.statusText}`);
        }

        const xml = await res.text();

        // Extract all server URLs from sitemap
        const urlMatches = xml.matchAll(/<loc>(https:\/\/glama\.ai\/mcp\/servers\/([^<]+))<\/loc>/g);
        const serverUrls: string[] = [];

        for (const match of urlMatches) {
            serverUrls.push(match[1]);
        }

        console.log(`  Found ${serverUrls.length} server URLs in sitemap`);
        console.log(`  Fetching full metadata for each server (this will take a while)...`);

        // Process servers with concurrency control
        let processed = 0;
        let successful = 0;

        for (let i = 0; i < serverUrls.length; i += CONCURRENCY) {
            const batch = serverUrls.slice(i, i + CONCURRENCY);

            const results = await Promise.all(
                batch.map(async (serverUrl) => {
                    try {
                        // Rate limiting
                        await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY));

                        // Extract namespace and slug from URL
                        const urlParts = serverUrl.replace('https://glama.ai/mcp/servers/', '').split('/');
                        let namespace = "unknown";
                        let slug = "unknown";

                        if (urlParts.length === 2) {
                            namespace = urlParts[0].replace('@', '');
                            slug = urlParts[1];
                        } else if (urlParts.length === 1) {
                            slug = urlParts[0].replace('@', '');
                        }

                        // Fetch the actual server page
                        const pageRes = await fetch(serverUrl);
                        if (!pageRes.ok) {
                            return null;
                        }

                        const html = await pageRes.text();

                        // ===================================================================
                        // CRITICAL: Extract actual server name from page
                        // ===================================================================
                        const fallbackName = `${namespace}/${slug}`;
                        const actualName = cleanServerName(extractNameFromHtml(html, fallbackName));

                        // Extract description
                        const description = extractDescription(html, `MCP server: ${actualName}`);

                        // ===================================================================
                        // CRITICAL: Extract GitHub repository from Resources section (ALWAYS present)
                        // ===================================================================
                        const repoUrl = extractGitHubRepoFromGlamaResources(html) || extractGitHubRepo(html);

                        // ===================================================================
                        // CRITICAL: Skip if from modelcontextprotocol registry origin
                        // (we already have these from primary Registry MCP source)
                        // ===================================================================
                        if (repoUrl && isFromRegistryOrigin(repoUrl)) {
                            return null; // Skip registry duplicates
                        }

                        // ===================================================================
                        // CRITICAL: Extract packages (NPM + Docker) with README hints
                        // ===================================================================
                        const npmPackage = extractNpmPackageFromGlamaHtml(html) || extractNpmPackageFromReadme(html);
                        const dockerImage = extractDockerImageFromGlamaHtml(html) || extractDockerImageFromReadme(html);
                        const transportHints = extractTransportHintsFromReadme(html);

                        const packages: PackageInfo[] = [];
                        if (npmPackage) packages.push(buildNpmPackageInfo(npmPackage));
                        if (dockerImage) packages.push(buildDockerPackageInfo(dockerImage));

                        // ===================================================================
                        // CRITICAL: Follow GitHub repo to get package.json (if no packages yet)
                        // ===================================================================
                        if (repoUrl && packages.length === 0) {
                            try {
                                const branches = ['main', 'master', 'HEAD'];
                                for (const branch of branches) {
                                    const packageJsonUrl = repoUrl
                                        .replace('github.com', 'raw.githubusercontent.com')
                                        .replace(/\.git$/, '') + `/${branch}/package.json`;

                                    const pkgRes = await fetch(packageJsonUrl);
                                    if (pkgRes.ok) {
                                        const packageJsonData = await pkgRes.json();
                                        const npmFromPackageJson = extractNpmFromPackageJson(packageJsonData);
                                        if (npmFromPackageJson) {
                                            packages.push(buildNpmPackageInfo(npmFromPackageJson));
                                        }
                                        break;
                                    }
                                }
                            } catch (e) {
                                // Ignore fetch errors
                            }
                        }

                        // ===================================================================
                        // CRITICAL: Extract tools metadata from Tools section
                        // ===================================================================
                        const tools = extractToolsFromGlamaHtml(html);

                        // Extract transport and remote URL
                        const remoteUrl = extractRemoteServerUrl(html);
                        const transport = determineTransport(false, remoteUrl);

                        // ===================================================================
                        // Containerization filtering  
                        // ===================================================================
                        const hasDocker = hasExistingDockerImage(packages, html); // OLD: html.toLowerCase().includes('docker.io/') ||
                        html.toLowerCase().includes('ghcr.io/');

                        const isNpm = isNpmOnly(packages, repoUrl);

                        // Build attributes with transport and containerization markers
                        const attributes: string[] = [];

                        if (transport === "http" || remoteUrl) {
                            attributes.push("hosting:remote-capable");
                        } else {
                            attributes.push("hosting:stdio");
                        }

                        if (hasDocker) {
                            attributes.push("has-docker-image");
                        }
                        if (isNpm) {
                            attributes.push("npm-only");
                        }

                        const id = `glama-${namespace}-${slug}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");

                        const server: McpServer = {
                            id,
                            name: actualName,  // ← Using actual name from page
                            namespace,
                            slug,
                            description,
                            attributes,
                            repository: repoUrl ? { url: repoUrl } : undefined,
                            tools,  // ← Tools metadata extracted
                            packages,
                            transport,
                            remoteUrl,
                            source: "glama",
                        };

                        return server;
                    } catch (error) {
                        // Skip failed servers
                        return null;
                    }
                })
            );

            // Add successful results
            for (const result of results) {
                if (result) {
                    allServers.push(result);
                    successful++;
                }
                processed++;
            }

            // Progress update every batch
            process.stdout.write(`\r  Processed ${processed}/${serverUrls.length} servers (${successful} successful)`);
        }

        console.log(`\r  Processed ${processed}/${serverUrls.length} servers (${successful} successful) - Complete!`);
    } catch (error) {
        console.error(`  Error fetching Glama servers: ${error}`);
    }

    console.log(`  Total from Glama: ${allServers.length}`);
    return allServers;
}

// =============================================================================
// Main
// =============================================================================

async function main() {
    console.log("╔══════════════════════════════════════════════════════════════╗");
    console.log("║  Glama.ai MCP Server Sync                                    ║");
    console.log("╚══════════════════════════════════════════════════════════════╝");

    const servers = await fetchGlamaServers();

    // Calculate metadata completeness
    const withTools = servers.filter(s => s.tools && s.tools.length > 0).length;
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
    const alreadyRemote = servers.filter(s => s.remoteUrl || s.transport === "http").length;
    const needsContainer = servers.filter(s => {
        const isRemote = s.transport === "http" || s.remoteUrl;
        const hasDockerPkg = s.packages && s.packages.some(p => p.registryType === "oci" || p.registryType === "docker");
        const hasNpmPkg = s.packages && s.packages.some(p => p.registryType === "npm" || p.registryType === "npmjs");

        // Needs containerization if: stdio-only + no Docker/NPM + has repo
        return !isRemote && !hasDockerPkg && !hasNpmPkg && s.repository?.url;
    }).length;

    // Write output
    const registryData: RegistryData = {
        source: "glama",
        updatedAt: new Date().toISOString(),
        count: servers.length,
        servers,
    };

    await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
    await fs.writeFile(OUTPUT_PATH, JSON.stringify(registryData, null, 2), "utf8");

    // Summary
    console.log("\n╔══════════════════════════════════════════════════════════════╗");
    console.log("║  Glama.ai Sync Complete                                      ║");
    console.log("╠══════════════════════════════════════════════════════════════╣");
    console.log(`║  Total servers: ${servers.length.toString().padEnd(45)}║`);
    console.log(`║  With tools metadata: ${withTools.toString().padEnd(39)}║`);
    console.log(`║  With repository: ${withRepo.toString().padEnd(43)}║`);
    console.log(`║  With packages: ${withPackages.toString().padEnd(45)}║`);
    console.log(`║  Remote-capable (HTTP/SSE): ${remoteCapable.toString().padEnd(33)}║`);
    console.log(`║  Stdio-only: ${stdioOnly.toString().padEnd(48)}║`);
    console.log("╠══════════════════════════════════════════════════════════════╣");
    console.log("║  CONTAINERIZATION REQUIREMENTS                               ║");
    console.log(`║  Already has Docker image: ${hasDocker.toString().padEnd(34)}║`);
    console.log(`║  Can use npx directly: ${canUseNpx.toString().padEnd(38)}║`);
    console.log(`║  Needs containerization: ${needsContainer.toString().padEnd(36)}║`);
    console.log(`║  Already remote (skip): ${alreadyRemote.toString().padEnd(37)}║`);
    console.log("╠══════════════════════════════════════════════════════════════╣");
    console.log(`║  Output: mcp/src/data/glamaServers.json                      ║`);
    console.log("╚══════════════════════════════════════════════════════════════╝");
}

main().catch((err) => {
    console.error("\nGlama.ai sync failed:", err);
    process.exit(1);
});
