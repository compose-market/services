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
const REQUEST_DELAY = 1000; // 1 second between requests to avoid rate limiting

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
  source: "mcp-registry" | "awesome-mcp-servers";
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
// Awesome MCP Servers README Parsing
// =============================================================================

interface ParsedEntry {
  name: string;
  description: string;
  repoUrl: string;
  category?: string;
}

function parseAwesomeReadme(content: string): ParsedEntry[] {
  const entries: ParsedEntry[] = [];
  const lines = content.split("\n");

  let currentCategory = "";

  // Regex to match markdown links: - [Name](url) - Description
  // or: - [Name](url) Description
  const entryRegex = /^\s*-\s*\[([^\]]+)\]\(([^)]+)\)\s*[-–]?\s*(.*)$/;

  for (const line of lines) {
    // Track category headers (## Category or ### Category)
    const headerMatch = line.match(/^#{2,4}\s+(.+)$/);
    if (headerMatch) {
      currentCategory = headerMatch[1].trim();
      continue;
    }

    // Parse list entries
    const match = line.match(entryRegex);
    if (match) {
      const [, name, url, description] = match;

      // Only include GitHub repositories (MCP servers)
      if (url.includes("github.com") && !url.includes("/issues") && !url.includes("/discussions")) {
        entries.push({
          name: name.trim(),
          description: description.trim() || name.trim(),
          repoUrl: url.trim(),
          category: currentCategory || undefined,
        });
      }
    }
  }

  return entries;
}

function extractGitHubInfo(url: string): { namespace: string; slug: string } {
  // Parse: https://github.com/owner/repo or https://github.com/owner/repo/tree/...
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (match) {
    return { namespace: match[1], slug: match[2].replace(/\.git$/, "") };
  }
  return { namespace: "unknown", slug: "unknown" };
}

async function fetchAwesomeServers(): Promise<McpServer[]> {
  console.log("\n[2/2] Fetching from awesome-mcp-servers...");

  const res = await fetch(AWESOME_MCP_README);
  if (!res.ok) {
    console.warn(`  Warning: Could not fetch README: ${res.status}`);
    return [];
  }

  const content = await res.text();
  const entries = parseAwesomeReadme(content);

  console.log(`  Parsed ${entries.length} GitHub entries from README`);

  const servers: McpServer[] = [];

  for (const entry of entries) {
    const { namespace, slug } = extractGitHubInfo(entry.repoUrl);
    const id = `awesome-${namespace}-${slug}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");

    // Map category to attributes
    const attributes: string[] = [];
    if (entry.category) {
      const cat = entry.category.toLowerCase();
      if (cat.includes("official") || cat.includes("reference")) {
        attributes.push("category:official");
      }
      if (cat.includes("browser") || cat.includes("web")) {
        attributes.push("category:browser");
      }
      if (cat.includes("database") || cat.includes("data")) {
        attributes.push("category:data");
      }
      if (cat.includes("file") || cat.includes("storage")) {
        attributes.push("category:storage");
      }
      if (cat.includes("code") || cat.includes("dev")) {
        attributes.push("category:developer-tools");
      }
      if (cat.includes("ai") || cat.includes("llm") || cat.includes("ml")) {
        attributes.push("category:ai");
      }
    }

    servers.push({
      id,
      name: entry.name,
      namespace,
      slug,
      description: entry.description,
      attributes,
      repository: { url: entry.repoUrl },
      source: "awesome-mcp-servers",
    });
  }

  return servers;
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
        await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY));

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
            attributes: [],
            repository: repoUrl ? { url: repoUrl } : undefined,
            packages: npmPackage ? [{
              registryType: "npm",
              identifier: npmPackage,
            }] : undefined,
            source: "mcp-registry",
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

async function fetchPulseMcpServers(): Promise<McpServer[]> {
  console.log("\n[4/5] Fetching from pulsemcp.com...");

  const servers: McpServer[] = [];

  try {
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      // Rate limiting
      await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY));

      const res = await fetch(`${PULSEMCP_BASE}/servers?page=${page}`);
      if (!res.ok) {
        console.warn(`  Warning: Could not fetch PulseMCP page ${page}: ${res.status}`);
        break;
      }

      const html = await res.text();

      // Extract server links from the page
      // Pattern: /servers/<provider-slug>
      const serverLinkRegex = /href="\/servers\/([^"]+)"/g;
      const matches = [...html.matchAll(serverLinkRegex)];

      if (matches.length === 0) {
        hasMore = false;
        break;
      }

      console.log(`  Processing page ${page}: ${matches.length} servers`);

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

          // Extract namespace from GitHub URL or use provider name
          let namespace = "unknown";
          let slug = serverSlug;

          if (githubMatch) {
            const parts = githubMatch[1].split('/');
            if (parts.length >= 2) {
              namespace = parts[0];
              slug = parts[1].replace(/\.git$/, '');
            }
          }

          const id = `pulsemcp-${namespace}-${slug}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");

          // Check if it's remote-capable
          const isRemote = serverPageHtml.includes('Remote Available') || serverPageHtml.includes('remote');

          const server: McpServer = {
            id,
            name: title,
            namespace,
            slug,
            description: description || `MCP server from PulseMCP: ${title}`,
            attributes: isRemote ? ["hosting:remote-capable"] : [],
            repository: repoUrl ? { url: repoUrl } : undefined,
            source: "mcp-registry",
          };

          servers.push(server);
        } catch (error) {
          console.warn(`  Warning: Failed to fetch ${serverSlug}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      console.log(`  Fetched ${servers.length} total servers so far`);

      // Check if there's a next page
      hasMore = html.includes('Next') || html.includes(`page=${page + 1}`);
      page++;

      // Safety limit to avoid infinite loops
      if (page > 200) {
        console.warn(`  Warning: Reached page limit (200), stopping`);
        break;
      }
    }
  } catch (error) {
    console.warn(`  Warning: Failed to scrape PulseMCP: ${error}`);
  }

  console.log(`  Total from PulseMCP: ${servers.length}`);
  return servers;
}

// =============================================================================
// Deduplication & Merging
// =============================================================================

function deduplicateServers(servers: McpServer[]): McpServer[] {
  const byRepo = new Map<string, McpServer>();

  for (const server of servers) {
    const repoUrl = server.repository?.url?.toLowerCase().replace(/\.git$/, "").replace(/\/$/, "");

    if (!repoUrl) {
      // No repo URL - use ID as key
      const key = `id:${server.source}:${server.id}`;
      if (!byRepo.has(key)) {
        byRepo.set(key, server);
      }
      continue;
    }

    const existing = byRepo.get(repoUrl);

    if (!existing) {
      byRepo.set(repoUrl, server);
    } else {
      // Prefer MCP Registry source (has more metadata)
      if (server.source === "mcp-registry" && existing.source !== "mcp-registry") {
        // MCP Registry has transport info, packages, remotes - overwrite
        byRepo.set(repoUrl, server);
      }
      // Merge attributes if both exist
      else if (existing.source === "mcp-registry" && server.source !== "mcp-registry") {
        // Keep MCP Registry data, but add any attributes from awesome-mcp-servers
        const mergedAttrs = new Set([...(existing.attributes || []), ...(server.attributes || [])]);
        existing.attributes = Array.from(mergedAttrs);
      }
    }
  }

  return Array.from(byRepo.values());
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
  const awesomeServers = await fetchAwesomeServers();
  const mcpSoServers = await fetchMcpSoServers();
  const pulseMcpServers = await fetchPulseMcpServers();

  console.log("\n[5/5] Deduplicating...");

  // Combine and deduplicate
  const allServers = [...mcpRegistryServers, ...awesomeServers, ...mcpSoServers, ...pulseMcpServers];
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

  // Stats
  const fromMcpRegistry = deduplicated.filter(s => s.source === "mcp-registry").length;
  const fromAwesome = deduplicated.filter(s => s.source === "awesome-mcp-servers").length;
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
  console.log(`║  From awesome-mcp-servers: ${fromAwesome.toString().padEnd(34)}║`);
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
