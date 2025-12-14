/**
 * Mass-dump script: syncMcpServers
 * 
 * Fetches MCP servers from multiple sources:
 * 1. Glama's directory API (paginated)
 * 2. awesome-mcp-servers GitHub README (parsed)
 * 
 * Deduplicates by repository URL and writes to data/mcpServers.json
 * 
 * Run with: npx tsx scripts/sync.ts
 */
import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GLAMA_API_BASE = "https://glama.ai/api/mcp/v1/servers";
const AWESOME_MCP_README = "https://raw.githubusercontent.com/punkpeye/awesome-mcp-servers/main/README.md";
const OUTPUT_PATH = path.resolve(__dirname, "../data/mcpServers.json");
const PAGE_SIZE = 100;

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
  spdxLicense?: { name?: string; url?: string } | null;
  tools?: Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  }>;
  url?: string;
  environmentVariablesJsonSchema?: Record<string, unknown> | null;
  source: "glama" | "awesome-mcp-servers";
  [key: string]: unknown;
}

interface GlamaApiResponse {
  pageInfo: {
    endCursor: string | null;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
    startCursor: string | null;
  };
  servers: Omit<McpServer, "source">[];
}

export interface RegistryData {
  sources: string[];
  updatedAt: string;
  count: number;
  servers: McpServer[];
}

// =============================================================================
// Glama API Fetching
// =============================================================================

async function fetchGlamaPage(cursor?: string): Promise<GlamaApiResponse> {
  const params = new URLSearchParams({ first: String(PAGE_SIZE) });
  if (cursor) {
    params.set("after", cursor);
  }
  
  const url = `${GLAMA_API_BASE}?${params.toString()}`;
  const res = await fetch(url);
  
  if (!res.ok) {
    throw new Error(`Glama API error: ${res.status} ${res.statusText}`);
  }
  
  return res.json() as Promise<GlamaApiResponse>;
}

async function fetchGlamaServers(): Promise<McpServer[]> {
  console.log("\n[1/2] Fetching from Glama API...");
  
  const allServers: McpServer[] = [];
  let cursor: string | undefined;
  let pageNum = 1;
  
  while (true) {
    process.stdout.write(`\r  Page ${pageNum}...`);
    
    const response = await fetchGlamaPage(cursor);
    
    for (const s of response.servers) {
      allServers.push({ ...s, source: "glama" } as McpServer);
    }
    
    process.stdout.write(`\r  Page ${pageNum}: ${response.servers.length} servers (total: ${allServers.length})`);
    
    if (!response.pageInfo.hasNextPage || !response.pageInfo.endCursor) {
      break;
    }
    
    cursor = response.pageInfo.endCursor;
    pageNum++;
    
    await new Promise(resolve => setTimeout(resolve, 100));
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
      // Prefer Glama source (has more metadata)
      if (server.source === "glama" && existing.source !== "glama") {
        byRepo.set(repoUrl, server);
      }
      // Merge attributes if both exist
      else if (existing.source === "glama" && server.source !== "glama") {
        // Keep Glama, but add any attributes from awesome-mcp-servers
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
  const glamaServers = await fetchGlamaServers();
  const awesomeServers = await fetchAwesomeServers();
  
  console.log("\n[3/3] Deduplicating...");
  
  // Combine and deduplicate
  const allServers = [...glamaServers, ...awesomeServers];
  const deduplicated = deduplicateServers(allServers);
  
  // Sort by namespace/slug for deterministic output
  deduplicated.sort((a, b) => {
    const na = (a.namespace || "") + "/" + (a.slug || "");
    const nb = (b.namespace || "") + "/" + (b.slug || "");
    return na.localeCompare(nb);
  });

  // Write output
  const registryData: RegistryData = {
    sources: ["glama.ai/api/mcp/v1/servers", "github.com/punkpeye/awesome-mcp-servers"],
    updatedAt: new Date().toISOString(),
    count: deduplicated.length,
    servers: deduplicated,
  };

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(registryData, null, 2), "utf8");

  // Stats
  const fromGlama = deduplicated.filter(s => s.source === "glama").length;
  const fromAwesome = deduplicated.filter(s => s.source === "awesome-mcp-servers").length;
  const withTools = deduplicated.filter(s => s.tools && s.tools.length > 0).length;
  const withRepo = deduplicated.filter(s => s.repository?.url).length;
  const remoteCapable = deduplicated.filter(s => s.attributes?.includes("hosting:remote-capable")).length;
  
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║  Sync Complete                                               ║");
  console.log("╠══════════════════════════════════════════════════════════════╣");
  console.log(`║  Total servers: ${deduplicated.length.toString().padEnd(45)}║`);
  console.log(`║  From Glama API: ${fromGlama.toString().padEnd(44)}║`);
  console.log(`║  From awesome-mcp-servers: ${fromAwesome.toString().padEnd(34)}║`);
  console.log(`║  With tools metadata: ${withTools.toString().padEnd(39)}║`);
  console.log(`║  With repository URL: ${withRepo.toString().padEnd(39)}║`);
  console.log(`║  Remote-capable: ${remoteCapable.toString().padEnd(44)}║`);
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
