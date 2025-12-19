/**
 * Mass-dump script: syncMcpServers
 * 
 * Fetches MCP servers from multiple sources:
 * 1. Official MCP Registry (registry.modelcontextprotocol.io)
 * 2. awesome-mcp-servers GitHub README (supplementary)
 * 
 * Deduplicates by repository URL and writes to data/mcpServers.json with
 * transport metadata (stdio/http), container images, and remote URLs.
 * 
 * Run with: npx tsx scripts/sync.ts
 */
import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MCP_REGISTRY_API = "https://registry.modelcontextprotocol.io/v0/servers";
const AWESOME_MCP_README = "https://raw.githubusercontent.com/punkpeye/awesome-mcp-servers/main/README.md";
const MCP_SO_BASE = "https://mcp.so";
const PULSEMCP_BASE = "https://www.pulsemcp.com";
const OUTPUT_PATH = path.resolve(__dirname, "../data/mcpServers.json");
const PAGE_SIZE = 100;
const REQUEST_DELAY = 100; // 100ms between requests (faster fetching while still respectful)
const MCP_SO_REQUEST_DELAY = 200; // Slightly higher for mcp.so scraping

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
  tools?: Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  }>;
  url?: string;
  environmentVariablesJsonSchema?: Record<string, unknown> | null;
  // New fields for transport and containerization
  transport?: "stdio" | "http";
  image?: string;
  remoteUrl?: string;
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
  source: "mcp-registry" | "glama" | "mcp-so" | "pulsemcp";
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
    tools?: Array<{
      name: string;
      description?: string;
      inputSchema?: Record<string, unknown>;
    }>;
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
  sources: string[];
  updatedAt: string;
  count: number;
  servers: McpServer[];
}

// =============================================================================
// MCP Official Registry API Fetching
// =============================================================================

async function fetchMcpRegistryPage(cursor?: string): Promise<McpRegistryApiResponse> {
  const url = cursor
    ? `${MCP_REGISTRY_API}?cursor=${encodeURIComponent(cursor)}`
    : MCP_REGISTRY_API
    ;

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`MCP Registry API error: ${res.status} ${res.statusText}`);
  }

  return res.json() as Promise<McpRegistryApiResponse>;
}

async function fetchMcpRegistryServers(): Promise<McpServer[]> {
  console.log("\n[1/2] Fetching from Official MCP Registry...");

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

      // Extract namespace and slug from name (format: "namespace/slug" or "ai.company/server")
      const nameParts = s.name.split("/");
      const namespace = nameParts.length > 1 ? nameParts[0] : "unknown";
      const slug = nameParts.length > 1 ? nameParts.slice(1).join("-") : s.name.replace(/[^a-z0-9-]/gi, "-");

      // Generate unique ID
      const id = `mcp-registry-${namespace}-${slug}-${s.version}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");

      // Determine transport type
      let transport: "stdio" | "http" = "stdio";
      let remoteUrl: string | undefined;

      if (s.remotes && s.remotes.length > 0) {
        transport = "http";
        remoteUrl = s.remotes[0].url;
      }

      // Build attributes
      const attributes: string[] = [];
      if (transport === "http") {
        attributes.push("hosting:remote-capable");
      } else {
        attributes.push("hosting:stdio");
      }
      if (meta?.isLatest) {
        attributes.push("version:latest");
      }
      if (meta?.status === "active") {
        attributes.push("status:active");
      }

      const server: McpServer = {
        id,
        name: s.title || s.name,
        namespace,
        slug,
        description: s.description || `MCP server: ${s.name}`,
        attributes,
        repository: s.repository,
        url: s.websiteUrl,
        tools: s.tools,
        transport,
        remoteUrl,
        packages: s.packages,
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
// Glama.ai MCP Server Sitemap (replaces limited API)
// =============================================================================

async function fetchGlamaServers(): Promise<McpServer[]> {
  console.log("\n[2/5] Fetching from Glama.ai sitemap...");

  const allServers: McpServer[] = [];

  try {
    // Fetch the sitemap XML
    const sitemapUrl = "https://glama.ai/sitemaps/mcp-servers.xml";
    const res = await fetch(sitemapUrl);

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

    // Fetch each server's page to extract metadata
    let processed = 0;
    for (const serverUrl of serverUrls) {
      // Rate limiting
      if (processed > 0 && processed % 10 === 0) {
        await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY));
      }

      try {
        // Extract namespace and slug from URL
        // Format: https://glama.ai/mcp/servers/@namespace/slug or /namespace/slug
        const urlParts = serverUrl.replace('https://glama.ai/mcp/servers/', '').split('/');
        let namespace = "unknown";
        let slug = "unknown";

        if (urlParts.length === 2) {
          namespace = urlParts[0].replace('@', '');
          slug = urlParts[1];
        } else if (urlParts.length === 1) {
          // Some servers might not have namespace
          slug = urlParts[0].replace('@', '');
        }

        // For now, just create server entries from URL structure
        // We could optionally fetch each page for full metadata, but that would be slow
        const id = `glama-${namespace}-${slug}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");

        const server: McpServer = {
          id,
          name: `${namespace}/${slug}`,
          namespace,
          slug,
          description: `MCP server from Glama.ai: ${slug}`,
          attributes: [],
          source: "glama",
        };

        allServers.push(server);
        processed++;

        if (processed % 1000 === 0) {
          process.stdout.write(`\r  Processed ${processed}/${serverUrls.length} servers`);
        }
      } catch (error) {
        // Skip failed servers
        console.warn(`\n  Warning: Failed to process ${serverUrl}`);
      }
    }

    console.log(`\r  Processed ${processed}/${serverUrls.length} servers - Complete!`);
  } catch (error) {
    console.error(`  Error fetching Glama sitemap: ${error}`);
  }

  console.log(`  Total from Glama: ${allServers.length}`);
  return allServers;
}

// =============================================================================
// MCP.so Scraping via XML Sitemaps
// =============================================================================

async function fetchMcpSoServers(): Promise<McpServer[]> {
  console.log("\n[3/5] Fetching from mcp.so...");

  const servers: McpServer[] = [];
  const sitemapUrls = [
    "https://mcp.so/sitemap_projects_1.xml",
    "https://mcp.so/sitemap_projects_2.xml",
    "https://mcp.so/sitemap_projects_3.xml",
    "https://mcp.so/sitemap_projects_4.xml",
    "https://mcp.so/sitemap_projects_5.xml",
    "https://mcp.so/sitemap_projects_6.xml",
    "https://mcp.so/sitemap_projects_7.xml",
    "https://mcp.so/sitemap_projects_8.xml",
    "https://mcp.so/sitemap_projects_9.xml",
    "https://mcp.so/sitemap_projects_10.xml",
    "https://mcp.so/sitemap_projects_11.xml",
    "https://mcp.so/sitemap_projects_12.xml",
    "https://mcp.so/sitemap_projects_13.xml",
    "https://mcp.so/sitemap_projects_14.xml",
    "https://mcp.so/sitemap_projects_15.xml",
    "https://mcp.so/sitemap_projects_16.xml",
    "https://mcp.so/sitemap_projects_17.xml",
    "https://mcp.so/sitemap_projects_18.xml",
    "https://mcp.so/sitemap_projects_19.xml",
    "https://mcp.so/sitemap_projects_20.xml",
    "https://mcp.so/sitemap_projects_21.xml",
    "https://mcp.so/sitemap_projects_22.xml",
    "https://mcp.so/sitemap_projects_23.xml",
    "https://mcp.so/sitemap_projects_24.xml",
    "https://mcp.so/sitemap_projects_25.xml",
    "https://mcp.so/sitemap_projects_26.xml",
    "https://mcp.so/sitemap_projects_27.xml",
    "https://mcp.so/sitemap_projects_28.xml",
    "https://mcp.so/sitemap_projects_29.xml",
    "https://mcp.so/sitemap_projects_30.xml"
  ];

  try {
    // Fetch all sitemap XMLs
    for (const sitemapUrl of sitemapUrls) {
      console.log(`  Fetching ${sitemapUrl}...`);

      const res = await fetch(sitemapUrl);
      if (!res.ok) {
        console.warn(`  Warning: Could not fetch ${sitemapUrl}: ${res.status}`);
        continue;
      }

      const xml = await res.text();

      // Extract all <loc> URLs pointing to /server/
      const urlMatches = xml.matchAll(/<loc>(https:\/\/mcp\.so\/server\/([^<]+))<\/loc>/g);

      for (const match of urlMatches) {
        const [, fullUrl, path] = match;
        // path format: "server-name/namespace"
        const parts = path.split('/');
        if (parts.length < 2) continue;

        const slug = parts[0];
        const namespace = parts[1];

        // Rate limiting - only for individual page fetches
        await new Promise(resolve => setTimeout(resolve, MCP_SO_REQUEST_DELAY));

        try {
          const serverPageRes = await fetch(fullUrl);
          if (!serverPageRes.ok) continue;

          const serverPageHtml = await serverPageRes.text();

          // Extract GitHub repository URL
          const githubMatch = serverPageHtml.match(/github\.com\/([^"'\s<>]+)/);
          const repoUrl = githubMatch ? `https://github.com/${githubMatch[1].replace(/\/$/, '')}` : undefined;

          // Extract NPM package from config
          const npmConfigMatch = serverPageHtml.match(/"command":\s*"npx",\s*"args":\s*\[\s*"([^"]+)"/);
          const npmPackage = npmConfigMatch ? npmConfigMatch[1] : undefined;

          // Extract transport type
          let transport: "stdio" | "http" | undefined;
          if (serverPageHtml.includes('"stdio"') || serverPageHtml.includes('stdio')) {
            transport = "stdio";
          } else if (serverPageHtml.includes('"http"') || serverPageHtml.includes('"sse"')) {
            transport = "http";
          }

          // Extract remote URL
          const remoteUrlMatch = serverPageHtml.match(/https?:\/\/[^"\s<>]+\.(?:vercel\.app|railway\.app|render\.com|fly\.io|replit\.app)[^"\s<>]*/);
          const remoteUrl = remoteUrlMatch ? remoteUrlMatch[0] : undefined;

          // Extract description
          const descMatch = serverPageHtml.match(/<meta\s+(?:name|property)=["'](?:og:)?description["']\s+content=["']([^"']+)["']/i);
          const description = descMatch ? descMatch[1] : "";

          const id = `mcpso-${namespace}-${slug}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");

          const server: McpServer = {
            id,
            name: `${namespace}/${slug}`,
            namespace,
            slug,
            description: description || `MCP server from mcp.so: ${slug}`,
            attributes: remoteUrl ? ["hosting:remote-capable"] : [],
            repository: repoUrl ? { url: repoUrl } : undefined,
            transport,
            remoteUrl,
            packages: npmPackage ? [{
              registryType: "npm",
              identifier: npmPackage,
            }] : undefined,
            source: "mcp-so",
          };

          servers.push(server);

          if (servers.length % 100 === 0) {
            console.log(`  Fetched ${servers.length} servers from mcp.so`);
          }
        } catch (error) {
          console.warn(`  Warning: Failed to fetch ${namespace}/${slug}: ${error}`);
        }
      }
    }
  } catch (error) {
    console.warn(`  Warning: Failed to scrape mcp.so: ${error}`);
  }

  console.log(`  Total from mcp.so: ${servers.length}`);
  return servers;
}

// =============================================================================
// PulseMCP Scraping
// =============================================================================

interface PulseMCPPageData {
  servers: Array<{
    slug: string;
    title: string;
    description: string;
    namespace: string;
    repoUrl?: string;
    npmPackage?: string;
    transport?: "stdio" | "http";
    remoteUrl?: string;
    isRemote: boolean;
  }>;
  hasNextPage: boolean;
}

async function fetchPulseMCPPage(page: number): Promise<PulseMCPPageData> {
  const res = await fetch(`${PULSEMCP_BASE}/servers?page=${page}`);

  if (!res.ok) {
    throw new Error(`PulseMCP page ${page} error: ${res.status} ${res.statusText}`);
  }

  const html = await res.text();

  const servers: PulseMCPPageData['servers'] = [];

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

      // Extract GitHub repository
      const githubMatch = serverPageHtml.match(/github\.com\/([^"'\s<>)]+)/);
      const repoUrl = githubMatch ? `https://github.com/${githubMatch[1].replace(/\/$/, '')}` : undefined;

      // Extract server name and description from title/meta
      const titleMatch = serverPageHtml.match(/<title>([^<]+)<\/title>/);
      const title = titleMatch ? titleMatch[1].replace(' | PulseMCP', '').trim() : serverSlug;

      const descMatch = serverPageHtml.match(/<meta\s+(?:name|property)=["'](?:og:)?description["']\s+content=["']([^"']+)["']/i);
      const description = descMatch ? descMatch[1] : "";

      // Extract namespace from GitHub URL
      let namespace = "unknown";
      let slug = serverSlug;

      if (githubMatch) {
        const parts = githubMatch[1].split('/');
        if (parts.length >= 2) {
          namespace = parts[0];
          slug = parts[1].replace(/\.git$/, '');
        }
      }

      // Extract NPM package if present
      const npmMatch = serverPageHtml.match(/npx\s+([^"\s<]+)|npm\s+install\s+([^"\s<]+)/i);
      const npmPackage = npmMatch ? (npmMatch[1] || npmMatch[2]) : undefined;

      // Extract transport type (stdio or http)
      let transport: "stdio" | "http" | undefined;
      if (serverPageHtml.includes('stdio')) {
        transport = "stdio";
      } else if (serverPageHtml.includes('SSE') || serverPageHtml.includes('Server-Sent Events') || serverPageHtml.includes('HTTP')) {
        transport = "http";
      }

      // Extract remote URL if available
      const remoteUrlMatch = serverPageHtml.match(/https?:\/\/[^"\s<>]+\.(?:vercel\.app|railway\.app|render\.com|fly\.io|replit\.app)[^"\s<>]*/);
      const remoteUrl = remoteUrlMatch ? remoteUrlMatch[0] : undefined;

      // Check if it's remote-capable
      const isRemote = serverPageHtml.includes('Remote Available') || serverPageHtml.includes('remote') || !!remoteUrl;

      servers.push({
        slug,
        title,
        description: description || `MCP server from PulseMCP: ${title}`,
        namespace,
        repoUrl,
        npmPackage,
        transport,
        remoteUrl,
        isRemote,
      });
    } catch (error) {
      // Skip failed servers
    }
  }

  // Check if there's a next page
  const hasNextPage = html.includes('Next') || html.includes(`page=${page + 1}`);

  return { servers, hasNextPage };
}

async function fetchPulseMcpServers(): Promise<McpServer[]> {
  console.log("\n[4/5] Fetching from PulseMCP...");

  const allServers: McpServer[] = [];
  let page = 1;

  while (true) {
    // Rate limiting before each page
    if (page > 1) {
      await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY));
    }

    const response = await fetchPulseMCPPage(page);

    for (const pulsemcpServer of response.servers) {
      const id = `pulsemcp-${pulsemcpServer.namespace}-${pulsemcpServer.slug}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");

      const server: McpServer = {
        id,
        name: pulsemcpServer.title,
        namespace: pulsemcpServer.namespace,
        slug: pulsemcpServer.slug,
        description: pulsemcpServer.description,
        attributes: pulsemcpServer.isRemote ? ["hosting:remote-capable"] : [],
        repository: pulsemcpServer.repoUrl ? { url: pulsemcpServer.repoUrl } : undefined,
        transport: pulsemcpServer.transport,
        remoteUrl: pulsemcpServer.remoteUrl,
        packages: pulsemcpServer.npmPackage ? [{
          registryType: "npm",
          identifier: pulsemcpServer.npmPackage,
        }] : undefined,
        source: "pulsemcp",
      };

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
// Deduplication & Merging
// =============================================================================

/**
 * Generate a unique key for server deduplication based on metadata.
 * Uses namespace/slug as the canonical identifier.
 * 
 * This is more reliable than name normalization because:
 * - "google-calendar" and "google-docs" have different slugs
 * - Same server from different sources will have same namespace/slug
 * - Metadata-driven instead of string manipulation
 */
function getServerDeduplicationKey(server: McpServer): string {
  // Use namespace/slug as the primary key
  const namespace = (server.namespace || "").toLowerCase().trim();
  const slug = (server.slug || "").toLowerCase().trim();

  if (namespace && slug) {
    return `${namespace}/${slug}`;
  }

  // Fallback: try to extract from repository URL
  if (server.repository?.url) {
    const match = server.repository.url.match(/github\.com\/([^\/]+)\/([^\/\.]+)/);
    if (match) {
      return `${match[1]}/${match[2]}`.toLowerCase();
    }
  }

  // Last resort: use the server ID
  return server.id.toLowerCase();
}

function deduplicateServers(servers: McpServer[]): McpServer[] {
  const byKey = new Map<string, McpServer>();
  const duplicateCount = new Map<string, number>();

  for (const server of servers) {
    const key = getServerDeduplicationKey(server);
    const existing = byKey.get(key);

    if (!existing) {
      // First occurrence - add it
      byKey.set(key, server);
      duplicateCount.set(key, 1);
    } else {
      // Duplicate detected - track count
      duplicateCount.set(key, (duplicateCount.get(key) || 1) + 1);

      // Prefer sources in priority order: mcp-registry > glama > mcp-so > pulsemcp
      const sourcePriority = {
        "mcp-registry": 4,
        "glama": 3,
        "mcp-so": 2,
        "pulsemcp": 1,
        "awesome-mcp-servers": 0,
      };

      const existingPriority = sourcePriority[existing.source] || 0;
      const newPriority = sourcePriority[server.source] || 0;

      if (newPriority > existingPriority) {
        // Higher priority source - replace
        byKey.set(key, server);
      } else if (newPriority === existingPriority) {
        // Same priority - merge metadata, prefer non-empty values
        const merged: McpServer = { ...existing };

        // Merge repository info
        if (server.repository?.url && !existing.repository?.url) {
          merged.repository = server.repository;
        }

        // Merge packages
        if (server.packages && server.packages.length > 0 && (!existing.packages || existing.packages.length === 0)) {
          merged.packages = server.packages;
        }

        // Merge remotes/remoteUrl
        if (server.remotes && server.remotes.length > 0 && (!existing.remotes || existing.remotes.length === 0)) {
          merged.remotes = server.remotes;
        }
        if (server.remoteUrl && !existing.remoteUrl) {
          merged.remoteUrl = server.remoteUrl;
        }

        // Merge transport
        if (server.transport && !existing.transport) {
          merged.transport = server.transport;
        }

        // Merge tools
        if (server.tools && server.tools.length > 0 && (!existing.tools || existing.tools.length === 0)) {
          merged.tools = server.tools;
        }

        byKey.set(key, merged);
      }
      // Otherwise keep existing (lower priority source doesn't replace)
    }
  }

  // Log duplicate statistics
  const hadDuplicates = Array.from(duplicateCount.entries()).filter(([_, count]) => count > 1);
  if (hadDuplicates.length > 0) {
    console.log(`\n  Found ${hadDuplicates.length} servers with duplicates across sources`);
    console.log(`  (Total duplicates removed: ${servers.length - byKey.size})`);
  }

  return Array.from(byKey.values());
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  MCP Registry Sync                                           ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");

  // Fetch from all sources
  const mcpRegistryServers = await fetchMcpRegistryServers();
  const glamaServers = await fetchGlamaServers();
  const mcpSoServers = await fetchMcpSoServers();
  const pulseMcpServers = await fetchPulseMcpServers();

  console.log("\n[5/5] Deduplicating...");

  // Combine and deduplicate
  const allServers = [...mcpRegistryServers, ...glamaServers, ...mcpSoServers, ...pulseMcpServers];
  const deduplicated = deduplicateServers(allServers);

  // Sort by namespace/slug for deterministic output
  deduplicated.sort((a, b) => {
    const na = (a.namespace || "") + "/" + (a.slug || "");
    const nb = (b.namespace || "") + "/" + (b.slug || "");
    return na.localeCompare(nb);
  });

  // Write output
  const registryData: RegistryData = {
    sources: [
      "registry.modelcontextprotocol.io/v0/servers",
      "glama.ai/sitemaps/mcp-servers.xml",
      "github.com/punkpeye/awesome-mcp-servers",
      "mcp.so",
      "pulsemcp.com",
    ],
    updatedAt: new Date().toISOString(),
    count: deduplicated.length,
    servers: deduplicated,
  };

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(registryData, null, 2), "utf8");

  // Stats by source
  const fromMcpRegistry = deduplicated.filter(s => s.source === "mcp-registry").length;
  const fromGlama = deduplicated.filter(s => s.source === "glama").length;
  const fromMcpSo = deduplicated.filter(s => s.source === "mcp-so").length;
  const fromPulseMcp = deduplicated.filter(s => s.source === "pulsemcp").length;
  const withTools = deduplicated.filter(s => s.tools && s.tools.length > 0).length;
  const withRepo = deduplicated.filter(s => s.repository?.url).length;
  const withPackages = deduplicated.filter(s => s.packages && s.packages.length > 0).length;
  const remoteCapable = deduplicated.filter(s => s.attributes?.includes("hosting:remote-capable")).length;
  const withImage = deduplicated.filter(s => s.image).length;

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║  MCP Registry Sync Complete                                  ║");
  console.log("╠══════════════════════════════════════════════════════════════╣");
  console.log(`║  Total servers: ${deduplicated.length.toString().padEnd(45)}║`);
  console.log(`║  From MCP Registry: ${fromMcpRegistry.toString().padEnd(41)}║`);
  console.log(`║  From Glama.ai: ${fromGlama.toString().padEnd(45)}║`);
  console.log(`║  From mcp.so: ${fromMcpSo.toString().padEnd(47)}║`);
  console.log(`║  From PulseMCP: ${fromPulseMcp.toString().padEnd(45)}║`);
  console.log(`║  With tools metadata: ${withTools.toString().padEnd(39)}║`);
  console.log(`║  With repository URL: ${withRepo.toString().padEnd(39)}║`);
  console.log(`║  With packages: ${withPackages.toString().padEnd(45)}║`);
  console.log(`║  Remote-capable (HTTP/SSE): ${remoteCapable.toString().padEnd(33)}║`);
  console.log(`║  With container image: ${withImage.toString().padEnd(38)}║`);
  console.log("╠══════════════════════════════════════════════════════════════╣");
  console.log(`║  Output: data/mcpServers.json                                ║`);
  console.log("╚══════════════════════════════════════════════════════════════╝");

  // Top namespaces
  const namespaces = new Map<string, number>();
  for (const s of deduplicated) {
    const ns = s.namespace || "unknown";
    namespaces.set(ns, (namespaces.get(ns) || 0) + 1);
  }

  const topNamespaces = Array.from(namespaces.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  console.log("\nTop namespaces:");
  for (const [ns, count] of topNamespaces) {
    console.log(`  ${ns}: ${count}`);
  }
}

main().catch((err) => {
  console.error("\nSync failed:", err);
  process.exit(1);
});
