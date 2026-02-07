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
const CONCURRENCY = 20;

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

/**
 * Process a single Glama server URL → McpServer or null.
 * Extracted as a standalone function so the HTML string is eligible for GC
 * as soon as it returns (no closure retention in Promise.all batches).
 */
async function processGlamaServer(serverUrl: string): Promise<McpServer | null> {
    try {
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
        if (!pageRes.ok) return null;

        const html = await pageRes.text();

        // Extract actual server name from page
        const fallbackName = `${namespace}/${slug}`;
        const actualName = cleanServerName(extractNameFromHtml(html, fallbackName));
        const description = extractDescription(html, `MCP server: ${actualName}`);

        // Extract GitHub repository
        const repoUrl = extractGitHubRepoFromGlamaResources(html) || extractGitHubRepo(html);

        // Skip if from modelcontextprotocol registry origin
        if (repoUrl && isFromRegistryOrigin(repoUrl)) return null;

        // Extract packages (NPM + Docker)
        const npmPackage = extractNpmPackageFromGlamaHtml(html) || extractNpmPackageFromReadme(html);
        const dockerImage = extractDockerImageFromGlamaHtml(html) || extractDockerImageFromReadme(html);

        const packages: PackageInfo[] = [];
        if (npmPackage) packages.push(buildNpmPackageInfo(npmPackage));
        if (dockerImage) packages.push(buildDockerPackageInfo(dockerImage));

        // Follow GitHub repo to get package.json (if no packages yet)
        if (repoUrl && packages.length === 0) {
            try {
                for (const branch of ['main', 'master']) {
                    const packageJsonUrl = repoUrl
                        .replace('github.com', 'raw.githubusercontent.com')
                        .replace(/\.git$/, '') + `/${branch}/package.json`;
                    const pkgRes = await fetch(packageJsonUrl);
                    if (pkgRes.ok) {
                        const packageJsonData = await pkgRes.json();
                        const npmFromPackageJson = extractNpmFromPackageJson(packageJsonData);
                        if (npmFromPackageJson) packages.push(buildNpmPackageInfo(npmFromPackageJson));
                        break;
                    }
                }
            } catch {
                // Ignore
            }
        }

        // Extract tools and transport
        const tools = extractToolsFromGlamaHtml(html);
        const remoteUrl = extractRemoteServerUrl(html);
        const transport = determineTransport(false, remoteUrl);

        // Containerization filtering
        const hasDocker = hasExistingDockerImage(packages, html);
        const isNpm = isNpmOnly(packages, repoUrl);

        const attributes: string[] = [];
        if (transport === "http" || remoteUrl) {
            attributes.push("hosting:remote-capable");
        } else {
            attributes.push("hosting:stdio");
        }
        if (hasDocker) attributes.push("has-docker-image");
        if (isNpm) attributes.push("npm-only");

        const id = `glama-${namespace}-${slug}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");

        return {
            id,
            name: actualName,
            namespace,
            slug,
            description,
            attributes,
            repository: repoUrl ? { url: repoUrl } : undefined,
            tools,
            packages,
            transport,
            remoteUrl,
            source: "glama",
        };
    } catch {
        return null;
    }
}

async function fetchGlamaServers(): Promise<McpServer[]> {
    console.log("Fetching from Glama.ai...");

    // Use a temp JSONL file to avoid holding all servers in memory
    const tmpFile = OUTPUT_PATH + ".tmp.jsonl";

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
        for (const match of urlMatches) serverUrls.push(match[1]);

        console.log(`  Found ${serverUrls.length} server URLs in sitemap`);
        console.log(`  Fetching full metadata for each server...`);

        // Clear temp file
        await fs.writeFile(tmpFile, "", "utf8");

        let processed = 0;
        let successful = 0;
        const BATCH_SIZE = CONCURRENCY;

        for (let i = 0; i < serverUrls.length; i += BATCH_SIZE) {
            const batch = serverUrls.slice(i, i + BATCH_SIZE);

            // Rate limit between batches
            await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY));

            const results = await Promise.all(batch.map(processGlamaServer));

            // Write successful results to temp file immediately, release memory
            for (const result of results) {
                processed++;
                if (result) {
                    await fs.appendFile(tmpFile, JSON.stringify(result) + "\n", "utf8");
                    successful++;
                }
            }

            // Progress update
            if (processed % 50 === 0 || processed === serverUrls.length) {
                process.stdout.write(`\r  Processed ${processed}/${serverUrls.length} servers (${successful} successful)`);
            }
        }

        console.log(`\r  Processed ${processed}/${serverUrls.length} servers (${successful} successful) - Complete!`);

        // Read results back from temp file
        const lines = (await fs.readFile(tmpFile, "utf8")).split("\n").filter(Boolean);
        const allServers: McpServer[] = lines.map(line => JSON.parse(line));

        // Cleanup temp file
        await fs.unlink(tmpFile).catch(() => { });

        console.log(`  Total from Glama: ${allServers.length}`);
        return allServers;

    } catch (error) {
        console.error(`  Error fetching Glama servers: ${error}`);
        // Try to salvage partial results from temp file
        try {
            const lines = (await fs.readFile(tmpFile, "utf8")).split("\n").filter(Boolean);
            const partial: McpServer[] = lines.map(line => JSON.parse(line));
            console.log(`  Salvaged ${partial.length} servers from partial sync`);
            return partial;
        } catch {
            return [];
        }
    }
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
