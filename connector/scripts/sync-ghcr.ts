/**
 * GHCR MCP Server Sync Script
 * 
 * Scrapes MCP servers from GitHub Container Registry packages.
 * Extracts metadata from compose-market/mcp packages (pages 1-101).
 * 
 * Output: backend/services/connector/data/ghcrServers.json
 * 
 * Run with: npx tsx scripts/sync-ghcr.ts
 */
import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";
import { JSDOM } from "jsdom";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GHCR_PACKAGES_BASE = "https://github.com/orgs/compose-market/packages/container/package";
const GHCR_PACKAGES_LIST = "https://github.com/compose-market/mcp/packages";
const TOTAL_PAGES = 101;
const OUTPUT_PATH = path.resolve(__dirname, "../data/refined/ghcrServers.json");
const REQUEST_DELAY = 500; // ms between requests to avoid rate limiting

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
    packages?: Array<{
        registryType: string;
        identifier: string;
        version?: string;
        pullCommand?: string;
        spawn?: {
            command: string;
            args: string[];
        };
    }>;
    transport?: "stdio" | "http";
    image?: string;
    remoteUrl?: string;
    source: "ghcr";
    [key: string]: unknown;
}

export interface RegistryData {
    source: "ghcr";
    updatedAt: string;
    count: number;
    servers: McpServer[];
}

// =============================================================================
// GitHub Packages Scraping
// =============================================================================

async function fetchPackagesFromPage(page: number): Promise<Array<{ name: string; url: string }>> {
    try {
        const url = `${GHCR_PACKAGES_LIST}?page=${page}`;
        console.log(`  Fetching page ${page}...`);

        const response = await fetch(url);
        if (!response.ok) {
            console.warn(`  Warning: Page ${page} returned ${response.status}`);
            return [];
        }

        const html = await response.text();
        const dom = new JSDOM(html);
        const document = dom.window.document;

        const packages: Array<{ name: string; url: string }> = [];

        // Find all package links - pattern: /orgs/compose-market/packages/container/package/mcp%2F{name}
        const packageLinks = document.querySelectorAll('a[href*="/packages/container/package/mcp%2F"]');

        for (const link of packageLinks) {
            const href = link.getAttribute('href');
            if (!href) continue;

            // Extract package name from URL-encoded path
            const match = href.match(/\/package\/mcp%2F([^/?#]+)/);
            if (match) {
                const encodedName = match[1];
                const decodedName = decodeURIComponent(encodedName);

                packages.push({
                    name: decodedName,
                    url: `https://github.com${href}`
                });
            }
        }

        // Deduplicate by name
        const unique = Array.from(new Map(packages.map(p => [p.name, p])).values());

        console.log(`  Found ${unique.length} packages on page ${page}`);
        return unique;
    } catch (error) {
        console.error(`  Error fetching page ${page}:`, error);
        return [];
    }
}

async function extractPackageMetadata(packageName: string, packageUrl: string): Promise<McpServer | null> {
    try {
        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY));

        // Fetch package page
        const response = await fetch(packageUrl);
        if (!response.ok) {
            return null;
        }

        const html = await response.text();
        const dom = new JSDOM(html);
        const document = dom.window.document;

        // Extract description from meta tag or page content
        let description = "";
        const metaDescription = document.querySelector('meta[name="description"]');
        if (metaDescription) {
            description = metaDescription.getAttribute('content') || "";
        }

        // Extract repository URL if linked
        let repository: { url?: string } | undefined;
        const repoLink = document.querySelector('a[href*="github.com/"][href*="/tree/"], a[href*="github.com/"][href*="/blob/"]');
        if (repoLink) {
            const href = repoLink.getAttribute('href');
            if (href) {
                // Extract repo URL without tree/blob path
                const repoMatch = href.match(/(https:\/\/github\.com\/[^\/]+\/[^\/]+)/);
                if (repoMatch) {
                    repository = { url: repoMatch[1] };
                }
            }
        }

        // Parse namespace and slug from package name
        let namespace = "compose-market";
        let slug = packageName;

        // If package name contains a separator, split it
        if (packageName.includes('/')) {
            const parts = packageName.split('/');
            if (parts.length === 2) {
                namespace = parts[0];
                slug = parts[1];
            }
        } else if (packageName.includes('-')) {
            // Try to extract namespace from hyphenated names
            const parts = packageName.split('-');
            if (parts.length > 1) {
                slug = packageName;
            }
        }

        // Generate ID
        const id = `ghcr-${namespace}-${slug}`
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, '-')
            .replace(/--+/g, '-');

        // Construct full image
        const image = `ghcr.io/compose-market/mcp/${packageName}:latest`;

        // Build server object
        const server: McpServer = {
            id,
            name: packageName,
            namespace,
            slug,
            description: description || `MCP Server: ${packageName}`,
            attributes: ["hosting:containerized", "source:ghcr"],
            repository,
            image,
            packages: [{
                registryType: "oci",
                identifier: image,
                pullCommand: `docker pull ${image}`,
                spawn: {
                    command: "docker",
                    args: ["run", "-p", "8080:8080", image]
                }
            }],
            transport: "http", // GHCR containers expose HTTP/SSE via port 8080
            remoteUrl: undefined, // These are for local spawning, not pre-hosted
            source: "ghcr"
        };

        return server;
    } catch (error) {
        console.error(`  Error extracting metadata for ${packageName}:`, error);
        return null;
    }
}

// =============================================================================
// Main
// =============================================================================

async function main() {
    console.log("╔══════════════════════════════════════════════════════════════╗");
    console.log("║  GHCR MCP Server Sync                                        ║");
    console.log("╚══════════════════════════════════════════════════════════════╝");
    console.log(`\nScraping pages 1-${TOTAL_PAGES} from ${GHCR_PACKAGES_LIST}...\n`);

    const allPackages: Array<{ name: string; url: string }> = [];

    // Fetch all pages
    for (let page = 1; page <= TOTAL_PAGES; page++) {
        const packagesOnPage = await fetchPackagesFromPage(page);
        allPackages.push(...packagesOnPage);

        process.stdout.write(`\r  Collected ${allPackages.length} packages from ${page}/${TOTAL_PAGES} pages...`);

        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY));
    }

    console.log(`\r  Collected ${allPackages.length} packages from ${TOTAL_PAGES} pages - Complete!`);

    // Deduplicate by name (in case packages appear on multiple pages)
    const uniquePackages = Array.from(
        new Map(allPackages.map(p => [p.name, p] as const)).values()
    );

    console.log(`  Unique packages: ${uniquePackages.length}`);
    console.log(`\nExtracting metadata for each package...`);

    const servers: McpServer[] = [];
    let processed = 0;

    for (const pkg of uniquePackages) {
        const server = await extractPackageMetadata(pkg.name, pkg.url);
        if (server) {
            servers.push(server);
        }
        processed++;
        process.stdout.write(`\r  Processed ${processed}/${uniquePackages.length} packages (${servers.length} successful)`);
    }

    console.log(`\r  Processed ${processed}/${uniquePackages.length} packages (${servers.length} successful) - Complete!`);

    // Calculate metadata completeness
    const withRepo = servers.filter(s => s.repository?.url).length;
    const withDescription = servers.filter(s => s.description).length;
    const withImage = servers.filter(s => s.image).length;

    // Write output
    const registryData: RegistryData = {
        source: "ghcr",
        updatedAt: new Date().toISOString(),
        count: servers.length,
        servers,
    };

    await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
    await fs.writeFile(OUTPUT_PATH, JSON.stringify(registryData, null, 2), "utf8");

    // Summary
    console.log("\n╔══════════════════════════════════════════════════════════════╗");
    console.log("║  GHCR Sync Complete                                          ║");
    console.log("╠══════════════════════════════════════════════════════════════╣");
    console.log(`║  Total servers: ${servers.length.toString().padEnd(45)}║`);
    console.log(`║  With repository: ${withRepo.toString().padEnd(43)}║`);
    console.log(`║  With description: ${withDescription.toString().padEnd(42)}║`);
    console.log(`║  With container image: ${withImage.toString().padEnd(38)}║`);
    console.log("╠══════════════════════════════════════════════════════════════╣");
    console.log(`║  Output: connector/data/ghcrServers.json                     ║`);
    console.log("╚══════════════════════════════════════════════════════════════╝");
}

main().catch((err) => {
    console.error("\nGHCR sync failed:", err);
    process.exit(1);
});
