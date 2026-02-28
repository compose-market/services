/**
 * mcp.so MCP Server Sync Script
 * 
 * Scrapes MCP servers from mcp.so sitemaps and individual server pages.
 * Extracts complete metadata including name, tools, packages, and transport types.
 * 
 * Output: mcp/src/data/mcpSo.json
 * 
 * Run with: npx tsx scripts/sync-mcp-so.ts
 */
import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";
import {
    validateGitHubRepoUrl,
    extractNameFromHtml,
    extractGitHubRepo,
    extractGitHubRepoFromMcpSo,
    extractServerConfigFromMcpSo,
    extractToolsFromMcpSoHtml,
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
    type PackageInfo,
    type Tool
} from "./lib/metadata-extractor.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MCP_SO_BASE = "https://mcp.so";
// Output path - CANONICAL LOCATION: backend/services/connector/data/
const OUTPUT_PATH = path.resolve(__dirname, "../data/mcpSo.json");
const REQUEST_DELAY = 200; // ms between requests (be respectful to mcp.so)

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
    source: "mcp-so";
    [key: string]: unknown;
}

export interface RegistryData {
    source: "mcp-so";
    updatedAt: string;
    count: number;
    servers: McpServer[];
}

// =============================================================================
// mcp.so Scraping
// =============================================================================

async function fetchMcpSoServers(): Promise<McpServer[]> {
    console.log("Fetching from mcp.so...");

    const servers: McpServer[] = [];

    try {
        // Dynamically fetch all sitemap XMLs (try 1-250, stop on 404)
        let sitemapIndex = 1;
        let consecutiveFailures = 0;
        const maxConsecutiveFailures = 3; // Stop after 3 consecutive 404s

        while (consecutiveFailures < maxConsecutiveFailures && sitemapIndex <= 250) {
            const sitemapUrl = `https://mcp.so/sitemap_projects_${sitemapIndex}.xml`;
            console.log(`  Fetching ${sitemapUrl}...`);

            try {
                const res = await fetch(sitemapUrl);
                if (!res.ok) {
                    if (res.status === 404) {
                        consecutiveFailures++;
                        sitemapIndex++;
                        continue;
                    }
                    console.warn(`  Warning: Failed to fetch ${sitemapUrl} (${res.status})`);
                    sitemapIndex++;
                    continue;
                }

                // Reset consecutive failures on success
                consecutiveFailures = 0;

                const xml = await res.text();
                const urls = xml.matchAll(/<loc>(https:\/\/mcp\.so\/([^<]+))<\/loc>/g);

                for (const match of urls) {
                    const fullUrl = match[1];
                    const parts = fullUrl.replace('https://mcp.so/', '').split('/');

                    // ================================================================
                    // CRITICAL: Skip client pages, only process server pages
                    // ================================================================
                    const pageType = parts[0];
                    if (pageType === 'client' || pageType.startsWith('@')) {
                        continue; // Skip clients
                    }

                    if (pageType !== 'server') {
                        continue; // Only process server pages
                    }

                    // URL format: mcp.so/server/slug/provenance
                    const namespace = parts.length > 2 ? parts[2] : parts[1]; // provenance as namespace
                    const slug = parts[1];

                    // Rate limiting - only for individual page fetches
                    await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY));

                    try {
                        const serverPageRes = await fetch(fullUrl);
                        if (!serverPageRes.ok) continue;

                        const serverPageHtml = await serverPageRes.text();

                        // ================================================================
                        // CRITICAL: Extract actual server name from page
                        // ================================================================
                        const fallbackName = `${namespace}/${slug}`;
                        const actualName = cleanServerName(extractNameFromHtml(serverPageHtml, fallbackName));

                        // Extract description
                        const description = extractDescription(serverPageHtml, `MCP server: ${actualName}`);

                        // ================================================================
                        // CRITICAL: Extract GitHub repository from "Visit Server" button
                        // ================================================================
                        const repoUrl = extractGitHubRepoFromMcpSo(serverPageHtml);

                        // ================================================================
                        // CRITICAL: Skip if from modelcontextprotocol registry origin
                        // (we already have these from primary Registry MCP source)
                        // ================================================================
                        if (repoUrl && isFromRegistryOrigin(repoUrl)) {
                            continue; // Skip registry duplicates
                        }

                        // ================================================================
                        // CRITICAL: Parse Server Config JSON from mcp.so
                        // ================================================================
                        const serverConfig = extractServerConfigFromMcpSo(serverPageHtml);

                        const packages: PackageInfo[] = [];
                        let remoteUrl: string | undefined;

                        // Extract remote URL from server config if it's an HTTP server
                        if (serverConfig) {
                            // Check if this is a remote server (has URL in config)
                            // Format: { mcpServers: { "name": { "url": "https://..." } } }
                            try {
                                const configStr = serverPageHtml.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([^<]+)<\/script>/);
                                if (configStr) {
                                    const nextData = JSON.parse(configStr[1]);
                                    const queries = nextData?.props?.pageProps?.trpcState?.json?.queries;
                                    if (queries && Array.isArray(queries)) {
                                        for (const query of queries) {
                                            const serverConfigData = query?.state?.data?.server_config;
                                            if (serverConfigData) {
                                                const config = typeof serverConfigData === 'string' ? JSON.parse(serverConfigData) : serverConfigData;
                                                remoteUrl = extractRemoteUrlFromServerJson(config);
                                                if (remoteUrl) break;
                                            }
                                        }
                                    }
                                }
                            } catch (e) {
                                // Ignore parse errors
                            }

                            // Derive package from spawn config
                            if (serverConfig.command === "npx" && serverConfig.args) {
                                const pkgIndex = serverConfig.args.indexOf("-y") + 1;
                                if (pkgIndex > 0 && serverConfig.args[pkgIndex]) {
                                    const npmPkg = serverConfig.args[pkgIndex];
                                    packages.push({
                                        ...buildNpmPackageInfo(npmPkg),
                                        spawn: serverConfig
                                    });
                                }
                            } else if (serverConfig.command === "docker" && serverConfig.args) {
                                const image = serverConfig.args[serverConfig.args.length - 1];
                                packages.push({
                                    ...buildDockerPackageInfo(image),
                                    spawn: serverConfig
                                });
                            }
                        }

                        // ================================================================
                        // CRITICAL: Follow GitHub repo to get package.json (if no packages yet)
                        // ================================================================
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
                                        const npmPackage = extractNpmFromPackageJson(packageJsonData);
                                        if (npmPackage) {
                                            packages.push(buildNpmPackageInfo(npmPackage));
                                        }
                                        break;
                                    }
                                }
                            } catch (e) {
                                // Ignore fetch errors
                            }
                        }

                        // ================================================================
                        // CRITICAL: Fallback - extract from README if still no packages
                        // ================================================================
                        if (packages.length === 0) {
                            const npmFromReadme = extractNpmPackageFromReadme(serverPageHtml);
                            if (npmFromReadme) {
                                packages.push(buildNpmPackageInfo(npmFromReadme));
                            }

                            const dockerFromReadme = extractDockerImageFromReadme(serverPageHtml);
                            if (dockerFromReadme) {
                                packages.push(buildDockerPackageInfo(dockerFromReadme));
                            }
                        }

                        // ================================================================
                        // CRITICAL: Extract tools metadata from __NEXT_DATA__
                        // ================================================================
                        const tools = extractToolsFromMcpSoHtml(serverPageHtml);

                        // Extract transport type
                        const transport = determineTransport(false, remoteUrl);

                        // ================================================================
                        // Containerization filtering
                        // ================================================================
                        const hasDocker = hasExistingDockerImage(packages, serverPageHtml); // OLD: serverPageHtml.toLowerCase().includes('docker.io/') ||
                        serverPageHtml.toLowerCase().includes('ghcr.io/');

                        const isNpm = isNpmOnly(packages, repoUrl);

                        // Build attributes with transport and containerization markers
                        const attributes: string[] = [];

                        if (transport === "http") {
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

                        const id = `mcpso-${namespace}-${slug}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");

                        const server: McpServer = {
                            id,
                            name: actualName,  // ← Using actual name from page
                            namespace,
                            slug,
                            description,
                            attributes,
                            repository: repoUrl ? { url: repoUrl } : undefined,
                            packages,
                            tools,  // ← Tools metadata extracted
                            transport,
                            remoteUrl,  // ← Remote URL if HTTP server
                            source: "mcp-so",
                        };

                        servers.push(server);

                        if (servers.length % 100 === 0) {
                            console.log(`  Fetched ${servers.length} servers from mcp.so`);
                        }
                    } catch (error) {
                        // Skip individual server errors
                        console.warn(`  Warning: Failed to process ${fullUrl}: ${error}`);
                    }
                }

                sitemapIndex++;
            } catch (error) {
                console.warn(`  Error fetching sitemap ${sitemapIndex}: ${error}`);
                consecutiveFailures++;
                sitemapIndex++;
            }
        }

        console.log(`  Total from mcp.so: ${servers.length}`);
    } catch (error) {
        console.error(`  Error fetching mcp.so servers: ${error}`);
    }

    return servers;
}

// =============================================================================
// Main
// =============================================================================

async function main() {
    console.log("╔══════════════════════════════════════════════════════════════╗");
    console.log("║  mcp.so MCP Server Sync                                      ║");
    console.log("╚══════════════════════════════════════════════════════════════╝");

    const servers = await fetchMcpSoServers();

    // Calculate metadata completeness
    const withTools = servers.filter(s => s.tools && s.tools.length > 0).length;
    const withRepo = servers.filter(s => s.repository?.url).length;
    const withPackages = servers.filter(s => s.packages && s.packages.length > 0).length;
    const remoteCapable = servers.filter(s => s.transport === "http").length;
    const stdioOnly = servers.filter(s => s.transport === "stdio").length;

    // Containerization analysis
    const hasDockerImage = servers.filter(s => s.packages && s.packages.some(p => p.registryType === "oci" || p.registryType === "docker")).length;
    const canUseNpx = servers.filter(s => {
        // Can use npx if has NPM package (regardless of repo - npx works with or without repo)
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
        source: "mcp-so",
        updatedAt: new Date().toISOString(),
        count: servers.length,
        servers,
    };

    await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
    await fs.writeFile(OUTPUT_PATH, JSON.stringify(registryData, null, 2), "utf8");

    // Summary
    console.log("\n╔══════════════════════════════════════════════════════════════╗");
    console.log("║  mcp.so Sync Complete                                        ║");
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
    console.log(`║  Output: mcp/src/data/mcpSo.json                             ║`);
    console.log("╚══════════════════════════════════════════════════════════════╝");
}

main().catch((err) => {
    console.error("\nmcp.so sync failed:", err);
    process.exit(1);
});
