/**
 * MCP Server Unified Sync Orchestrator
 * 
 * Loads servers from all source-specific JSON files, applies deduplication,
 * and outputs a unified registry to both:
 * - backend/services/connector/data/mcpServers.json  
 * - mcp/src/data/mcpServers.json
 * 
 * Deduplication strategy (priority order):
 * 1. Repository URL (same repo = same server)
 * 2. Actual name field
 * 3. NPM package identifier  
 * 4. Namespace/slug fallback
 * 
 * Run with: npx tsx scripts/sync.ts
 * OR run all sources first, then this:
 *   npx tsx scripts/sync-mcp-registry.ts
 *   npx tsx scripts/sync-glama.ts
 *   npx tsx scripts/sync-mcp-so.ts
 *   npx tsx scripts/sync-pulsemcp.ts
 *   npx tsx scripts/sync.ts
 */
import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";
import { validateGitHubRepoUrl, isFromRegistryOrigin } from "./lib/metadata-extractor.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Input paths (source-specific JSON files) - ALL in canonical location
const REGISTRY_MCP_PATH = path.resolve(__dirname, "../data/registryMcp.json");
const GLAMA_PATH = path.resolve(__dirname, "../data/glamaServers.json");
const MCP_SO_PATH = path.resolve(__dirname, "../data/mcpSo.json");
const PULSEMCP_PATH = path.resolve(__dirname, "../data/pulseMcp.json");

// Output path - SINGLE LOCATION (canonical)
const OUTPUT_PATH = path.resolve(__dirname, "../data/mcpServers.json");

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

export interface RegistryData {
  sources: string[];
  updatedAt: string;
  count: number;
  servers: McpServer[];
}

// =============================================================================
// Load Source Data
// =============================================================================

async function loadSourceData(filePath: string, sourceName: string): Promise<McpServer[]> {
  try {
    const data = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(data);
    console.log(`  ✓ Loaded ${parsed.count || parsed.servers?.length || 0} servers from ${sourceName}`);
    return parsed.servers || [];
  } catch (error) {
    console.warn(`  ⚠ Could not load ${sourceName}: ${error instanceof Error ? error.message : String(error)}`);
    console.warn(`    Run: npx tsx scripts/sync-${sourceName}.ts`);
    return [];
  }
}

// =============================================================================
// Deduplication Logic
// =============================================================================

/**
 * Generate a unique key for server deduplication based on metadata.
 * 
 * Priority order:
 * 1. Repository URL (same repo = same server) - most reliable
 * 2. Actual name field (not namespace/slug manipulation)
 * 3. NPM package identifier
 * 4. namespace/slug (least reliable, only as fallback)
 * 
 * This ensures:
 * - "google-calendar" and "google-docs" remain separate (different names/repos)
 * - Same server from 4 different sources gets deduplicated (same repo URL)
 * - Uses actual metadata instead of string manipulation
 */
function getServerDeduplicationKey(server: McpServer): string {
  // PRIMARY: Use repository URL (same repo = same server)
  // This is the most reliable identifier across sources
  if (server.repository?.url) {
    const cleanUrl = validateGitHubRepoUrl(server.repository.url);
    if (cleanUrl) {
      const match = cleanUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
      if (match && match[1] && match[2]) {
        return `repo:${match[1]}/${match[2]}`.toLowerCase();
      }
    }
  }

  // SECONDARY: Use actual name field (not namespace/slug)
  // This handles servers that explicitly declare their name
  if (server.name) {
    const cleanName = server.name.toLowerCase().trim()
      .replace(/^@/, '')           // Remove npm scope prefix
      .replace(/[\s\/]+/g, '-')    // Spaces and slashes to dashes
      .replace(/[^a-z0-9-]/g, '')  // Remove other special chars
      .replace(/--+/g, '-')        // Remove double dashes
      .replace(/^-+|-+$/g, '');    // Trim dashes

    if (cleanName) {
      return `name:${cleanName}`;
    }
  }

  // TERTIARY: Use npm package identifier
  // NPM packages are globally unique
  if (server.packages && server.packages.length > 0) {
    const npmPkg = server.packages.find(p => p.registryType === 'npm' || p.registryType === 'npmjs');
    if (npmPkg && npmPkg.identifier) {
      return `npm:${npmPkg.identifier.toLowerCase()}`;
    }
  }

  // QUATERNARY: namespace/slug (only when nothing else available)
  const namespace = (server.namespace || "").toLowerCase().trim();
  const slug = (server.slug || "").toLowerCase().trim();
  if (namespace && slug) {
    return `slug:${namespace}/${slug}`;
  }

  // Last resort: use the server ID
  return `id:${server.id.toLowerCase()}`;
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

        // Merge tools - CRITICAL: prefer the one with more/better tools
        if (server.tools && server.tools.length > 0) {
          if (!existing.tools || existing.tools.length === 0) {
            merged.tools = server.tools;
          } else if (server.tools.length > existing.tools.length) {
            // Prefer the source with more tools
            merged.tools = server.tools;
          }
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

    // Show top 10 most duplicated servers
    const topDupes = hadDuplicates
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    console.log("\n  Top duplicated servers:");
    for (const [key, count] of topDupes) {
      console.log(`    ${key}: ${count} copies`);
    }
  }

  return Array.from(byKey.values());
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  MCP Unified Registry Sync                                   ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");

  console.log("\n[1/5] Loading source data...");
  const mcpRegistryServers = await loadSourceData(REGISTRY_MCP_PATH, "mcp-registry");
  const glamaServers = await loadSourceData(GLAMA_PATH, "glama");
  const mcpSoServers = await loadSourceData(MCP_SO_PATH, "mcp-so");
  const pulseMcpServers = await loadSourceData(PULSEMCP_PATH, "pulsemcp");

  console.log("\n[2/5] Combining all sources...");
  // Filter out registry-origin duplicates from secondary sources BEFORE combining
  const mcpRegistryFiltered = mcpRegistryServers; // Keep all from primary source
  const glamaFiltered = glamaServers.filter(s => {
    if (s.repository?.url && isFromRegistryOrigin(s.repository.url)) {
      return false; // Skip if from registry origin
    }
    return true;
  });
  const mcpSoFiltered = mcpSoServers.filter(s => {
    if (s.repository?.url && isFromRegistryOrigin(s.repository.url)) {
      return false;
    }
    return true;
  });
  const pulseMcpFiltered = pulseMcpServers.filter(s => {
    if (s.repository?.url && isFromRegistryOrigin(s.repository.url)) {
      return false;
    }
    return true;
  });

  console.log(`  Registry origin filtering:`);
  console.log(`    Glama: ${glamaServers.length} -> ${glamaFiltered.length} (filtered ${glamaServers.length - glamaFiltered.length})`);
  console.log(`    mcp.so: ${mcpSoServers.length} -> ${mcpSoFiltered.length} (filtered ${mcpSoServers.length - mcpSoFiltered.length})`);
  console.log(`    PulseMCP: ${pulseMcpServers.length} -> ${pulseMcpFiltered.length} (filtered ${pulseMcpServers.length - pulseMcpFiltered.length})`);

  const allServers = [...mcpRegistryFiltered, ...glamaFiltered, ...mcpSoFiltered, ...pulseMcpFiltered];
  console.log(`  Total before deduplication: ${allServers.length}`);


  console.log("\n[3/5] Deduplicating...");
  const deduplicated = deduplicateServers(allServers);
  console.log(`  Total after deduplication: ${deduplicated.length}`);

  // Sort by namespace/slug for deterministic output
  deduplicated.sort((a, b) => {
    const na = (a.namespace || "") + "/" + (a.slug || "");
    const nb = (b.namespace || "") + "/" + (b.slug || "");
    return na.localeCompare(nb);
  });

  console.log("\n[4/5] Calculating statistics...");

  // Stats by source
  const fromMcpRegistry = deduplicated.filter(s => s.source === "mcp-registry").length;
  const fromGlama = deduplicated.filter(s => s.source === "glama").length;
  const fromMcpSo = deduplicated.filter(s => s.source === "mcp-so").length;
  const fromPulseMcp = deduplicated.filter(s => s.source === "pulsemcp").length;

  // Metadata completeness
  const withTools = deduplicated.filter(s => s.tools && s.tools.length > 0).length;
  const withRepo = deduplicated.filter(s => s.repository?.url).length;
  const withPackages = deduplicated.filter(s => s.packages && s.packages.length > 0).length;
  const withName = deduplicated.filter(s => s.name && s.name !== `${s.namespace}/${s.slug}`).length;

  // Use actual data fields, not attributes (which get lost during merging)
  const remoteCapable = deduplicated.filter(s =>
    s.transport === "http" || s.remoteUrl || (s.remotes && s.remotes.length > 0)
  ).length;

  const stdioOnly = deduplicated.filter(s =>
    s.transport !== "http" && !s.remoteUrl && (!s.remotes || s.remotes.length === 0)
  ).length;

  const withImage = deduplicated.filter(s => s.image).length;

  // Containerization candidates - use actual package data
  const hasDockerImage = deduplicated.filter(s =>
    s.packages && s.packages.some(p => p.registryType === "oci" || p.registryType === "docker")
  ).length;

  const canUseNpx = deduplicated.filter(s => {
    const hasNpm = s.packages && s.packages.some(p => p.registryType === "npm" || p.registryType === "npmjs");
    return hasNpm;
  }).length;

  const needsContainer = deduplicated.filter(s => {
    const hasRemote = s.transport === "http" || s.remoteUrl || (s.remotes && s.remotes.length > 0);
    const hasDocker = s.packages && s.packages.some(p => p.registryType === "oci" || p.registryType === "docker");
    const hasNpm = s.packages && s.packages.some(p => p.registryType === "npm" || p.registryType === "npmjs");
    const alreadyBuilt = !!s.image;

    // Needs containerization ONLY if NONE of these are available
    return !hasRemote && !hasDocker && !hasNpm && !alreadyBuilt && s.repository?.url;
  }).length;

  console.log("[5/5] Writing outputs...");

  // Write output
  const registryData: RegistryData = {
    sources: [
      "registry.modelcontextprotocol.io/v0/servers",
      "glama.ai/sitemaps/mcp-servers.xml",
      "mcp.so",
      "pulsemcp.com",
    ],
    updatedAt: new Date().toISOString(),
    count: deduplicated.length,
    servers: deduplicated,
  };

  // Write to SINGLE canonical location
  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(registryData, null, 2), "utf8");
  console.log(`  ✓ Written to: backend/services/connector/data/mcpServers.json`);

  // Summary
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║  MCP Unified Registry Sync Complete                          ║");
  console.log("╠══════════════════════════════════════════════════════════════╣");
  console.log(`║  Total servers: ${deduplicated.length.toString().padEnd(45)}║`);
  console.log(`║  From MCP Registry: ${fromMcpRegistry.toString().padEnd(41)}║`);
  console.log(`║  From Glama.ai: ${fromGlama.toString().padEnd(45)}║`);
  console.log(`║  From mcp.so: ${fromMcpSo.toString().padEnd(47)}║`);
  console.log(`║  From PulseMCP: ${fromPulseMcp.toString().padEnd(45)}║`);
  console.log("╠══════════════════════════════════════════════════════════════╣");
  console.log("║  METADATA COMPLETENESS                                       ║");
  console.log(`║  With tools metadata: ${withTools.toString().padEnd(39)}║`);
  console.log(`║  With repository URL: ${withRepo.toString().padEnd(39)}║`);
  console.log(`║  With packages: ${withPackages.toString().padEnd(45)}║`);
  console.log(`║  With actual name field: ${withName.toString().padEnd(36)}║`);
  console.log(`║  Remote-capable (HTTP/SSE): ${remoteCapable.toString().padEnd(33)}║`);
  console.log(`║  Stdio-only: ${stdioOnly.toString().padEnd(48)}║`);
  console.log("╠══════════════════════════════════════════════════════════════╣");
  console.log("║  CONTAINERIZATION ANALYSIS                                   ║");
  console.log(`║  Needs containerization: ${needsContainer.toString().padEnd(36)}║`);
  console.log(`║  Already has Docker image: ${hasDockerImage.toString().padEnd(34)}║`);
  console.log(`║  Can use npx directly: ${canUseNpx.toString().padEnd(38)}║`);
  console.log(`║  Already built (image field): ${withImage.toString().padEnd(31)}║`);
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

  console.log("\nTop 10 namespaces:");
  for (const [ns, count] of topNamespaces) {
    console.log(`  ${ns.padEnd(30)} ${count}`);
  }
}

main().catch((err) => {
  console.error("\nUnified sync failed:", err);
  process.exit(1);
});
