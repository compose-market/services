/**
 * MCP Registry Module
 * 
 * Loads servers from:
 * - MCP refined sources (data/refined: npxServers.json, httpServers.json, dockerServers.json, ghcrServers.json)
 * - GOAT plugins (data/goatPlugins.json)
 * - ElizaOS plugins (data/elizaPlugins.json)
 * - Internal tools (internal.ts)
 * 
 * Provides search/lookup functionality with Express router.
 */
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import {
  getInternalServers,
  type InternalMcpServer,
  isInternalServerAvailable,
  getMissingEnvForServer
} from "./internal.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve data directory - works for both dev (src/) and prod (dist/connector/src/)
// In dev: __dirname = connector/src -> ../data = connector/data
// In prod: __dirname = connector/dist/connector/src -> ../../../data = connector/data
function resolveDataDir(): string {
  // Try relative path first (works in dev)
  const devPath = path.resolve(__dirname, "../data");
  // For production build, go up from dist/connector/src to connector root, then data
  const prodPath = path.resolve(__dirname, "../../../data");
  // Check which exists by looking for refined subdirectory
  try {
    require("fs").accessSync(path.join(devPath, "refined"));
    return devPath;
  } catch {
    return prodPath;
  }
}
const DATA_DIR = resolveDataDir();


/** Mcp MCP server from the JSON dump */
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
  // Transport and containerization metadata
  transport?: "stdio" | "http";
  image?: string;
  remoteUrl?: string;
  packages?: Array<{
    registryType: string;
    identifier: string;
    version?: string;
    transport?: { type: string };
  }>;
  remotes?: Array<{
    type: string;
    url: string;
  }>;
  [key: string]: unknown;
}

/** Registry data from the JSON dump */
export interface RegistryData {
  sources: string[];
  updatedAt: string;
  count: number;
  servers: McpServer[];
}

/** Server origin types */
export type ServerOrigin = "mcp" | "internal" | "goat" | "eliza";

/** Record type: agent (autonomous AI agents) or plugin (tools/connectors) */
export type RecordType = "agent" | "plugin";

/** Unified server record for the registry */
export interface UnifiedServerRecord {
  /** Unique registry ID: "mcp:{id}", "internal:{id}", "goat:{id}", or "eliza:{id}" */
  registryId: string;
  /** Primary origin: mcp, internal, goat, or eliza */
  origin: ServerOrigin;
  /** Type classification: agent or plugin (for internal filtering) */
  type: RecordType;
  /** All sources that provide this plugin (for deduped entries) */
  sources: ServerOrigin[];
  /** Canonical key used for deduplication */
  canonicalKey: string;
  /** Human-readable name */
  name: string;
  /** Namespace (author/org) */
  namespace: string;
  /** URL-safe slug */
  slug: string;
  /** Description */
  description: string;
  /** Capability attributes */
  attributes: string[];
  /** Repository URL (if available) */
  repoUrl?: string;
  /** UI/directory URL */
  uiUrl?: string;
  /** Category for filtering */
  category?: string;
  /** Tags for search */
  tags: string[];
  /** Tool count */
  toolCount: number;
  /** Tools metadata (if available) */
  tools?: Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  }>;
  /** Whether this server is available (all env vars present) */
  available: boolean;
  /** Whether this plugin has live execution capability */
  executable: boolean;
  /** Connector ID for internal servers (maps to /connectors/:id) */
  connectorId?: string;
  /** Missing environment variables */
  missingEnv?: string[];
  /** Alternative registry IDs from other sources (for deduped entries) */
  alternateIds?: string[];
  // Transport and containerization support
  /** Transport type: stdio (local npm/pypi), http (remote SSE/streamable), docker (containerized) */
  transport?: "stdio" | "http" | "docker";
  /** Docker image name (if containerized) */
  image?: string;
  /** Remote URL (if HTTP/SSE server) */
  remoteUrl?: string;
  /** Raw server data */
  raw: McpServer | InternalMcpServer;
}

// =============================================================================
// Deduplication Logic
// =============================================================================

/** Priority order for deduplication (lower = higher priority) */
const ORIGIN_PRIORITY: Record<ServerOrigin, number> = {
  internal: 1, // Highest: our own tools
  goat: 2,      // Second: has live execution
  eliza: 3,    // Third: rich metadata
  mcp: 4,    // Lowest: external MCP servers
};

/**
 * Normalize a slug to a canonical key for deduplication.
 * Strips common prefixes and normalizes variations.
 */
function normalizeToCanonicalKey(slug: string, origin: ServerOrigin): string {
  let key = slug.toLowerCase().trim();

  // Strip common prefixes
  const prefixes = [
    "plugin-", "client-", "adapter-",
    "mcp-", "mcp_", "-mcp",
    "goat-", "eliza-",
  ];
  for (const prefix of prefixes) {
    if (key.startsWith(prefix)) {
      key = key.slice(prefix.length);
    }
    if (key.endsWith(prefix.replace("-", ""))) {
      key = key.slice(0, -prefix.length + 1);
    }
  }

  // Normalize common variations
  const normalizations: Record<string, string> = {
    "twitter": "twitter",
    "x": "twitter",
    "erc-20": "erc20",
    "erc-721": "erc721",
    "erc-1155": "erc1155",
    "coin-gecko": "coingecko",
    "coin_gecko": "coingecko",
    "coinmarketcap": "coinmarketcap",
    "coin-market-cap": "coinmarketcap",
    "poly-market": "polymarket",
    "uni-swap": "uniswap",
    "far-caster": "farcaster",
  };

  if (normalizations[key]) {
    key = normalizations[key];
  }

  // Remove trailing numbers/versions
  key = key.replace(/-v?\d+$/, "");

  return key;
}

/**
 * Clean a name/slug to a normalized format for registryId.
 * Matches logic from mcp/scripts/build-images.ts (lines 604-629).
 * 
 * Input: "Context7 MCP by renCosta2025 | Glama"
 * Output: "context7"
 * 
 * Input: "@modelcontextprotocol/server-github"
 * Output: "github"
 */
function cleanSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/^@[\w-]+\//, '')                     // Remove npm scope @scope/
    .replace(/^model-?context-?protocol[/-]?/gi, '') // Remove "modelcontextprotocol" prefix
    .replace(/^io-github-[\w-]*-?/gi, '')          // Remove "io-github-*" prefix
    .replace(/^io-/gi, '')                         // Remove "io-" prefix
    .replace(/^github-/gi, '')                     // Remove "github-" prefix  
    .replace(/\s*mcp\s*server\s*/gi, '')           // Remove "MCP Server"
    .replace(/\s*server\s*/gi, '')                 // Remove "Server"
    .replace(/\s*mcp\s*/gi, '')                    // Remove "MCP"
    .replace(/-mcp$/gi, '')                        // Remove trailing "-mcp"
    .replace(/^mcp-/gi, '')                        // Remove leading "mcp-"
    .replace(/-official$/gi, '')                   // Remove trailing "-official"
    .replace(/^official-/gi, '')                   // Remove leading "official-"
    .replace(/\s*by\s+[\w-]+/gi, '')               // Remove "by author"
    .replace(/\s*\|\s*.+$/g, '')                   // Remove "| Glama" etc
    .replace(/^goat[:-]/, '')                      // Remove goat prefix
    .replace(/^eliza[:-]/, '')                     // Remove eliza prefix
    .replace(/[^a-z0-9-]/g, '-')                   // Special chars to dashes
    .replace(/--+/g, '-')                          // Double dashes to single
    .replace(/^-+|-+$/g, '');                      // Trim dashes
}

/**
 * Deduplicate records by registryId (after cleanSlug normalization).
 * Merges metadata and keeps the highest-priority source as primary.
 */
function deduplicateRecords(records: UnifiedServerRecord[]): UnifiedServerRecord[] {
  const byRegistryId = new Map<string, UnifiedServerRecord[]>();

  // Group by registryId (which is now the clean slug format: origin:cleanSlug)
  for (const record of records) {
    const key = record.registryId;
    const existing = byRegistryId.get(key) || [];
    existing.push(record);
    byRegistryId.set(key, existing);
  }

  const deduplicated: UnifiedServerRecord[] = [];
  let mergedCount = 0;

  for (const [key, group] of byRegistryId) {
    if (group.length === 1) {
      // No duplicates
      deduplicated.push(group[0]);
      continue;
    }

    // Sort by priority (lowest number = highest priority)
    group.sort((a, b) => ORIGIN_PRIORITY[a.origin] - ORIGIN_PRIORITY[b.origin]);

    const primary = group[0];
    const others = group.slice(1);

    // Merge metadata from other sources
    const allSources = new Set<ServerOrigin>([primary.origin]);
    const allTags = new Set<string>(primary.tags);
    const allAttributes = new Set<string>(primary.attributes);
    const alternateIds: string[] = [];

    for (const other of others) {
      allSources.add(other.origin);
      alternateIds.push(other.registryId);
      other.tags.forEach(t => allTags.add(t));
      other.attributes.forEach(a => allAttributes.add(a));

      // Take longer description if available
      if (other.description.length > primary.description.length) {
        primary.description = other.description;
      }

      // Take repo URL if primary doesn't have one
      if (!primary.repoUrl && other.repoUrl) {
        primary.repoUrl = other.repoUrl;
      }

      // Take tools if primary doesn't have them
      if ((!primary.tools || primary.tools.length === 0) && other.tools && other.tools.length > 0) {
        primary.tools = other.tools;
        primary.toolCount = other.tools.length;
      }
    }

    // Update primary with merged data
    primary.sources = Array.from(allSources);
    primary.tags = Array.from(allTags);
    primary.attributes = Array.from(allAttributes);
    primary.alternateIds = alternateIds;

    deduplicated.push(primary);
    mergedCount += others.length;
  }

  if (mergedCount > 0) {
    console.log(`[registry] Deduplicated ${mergedCount} duplicate entries across sources`);
  }

  return deduplicated;
}

/** In-memory registry cache */
let REGISTRY: UnifiedServerRecord[] | null = null;
let REGISTRY_LOADED_AT: string | null = null;

/** Plugin record from sync-plugins.ts */
interface PluginRecord {
  id: string;
  name: string;
  slug: string;
  namespace: string;
  description: string;
  keywords: string[];
  version: string;
  repository?: string;
  homepage?: string;
  source: "goat" | "eliza";
}

interface PluginRegistryData {
  source: string;
  updatedAt: string;
  count: number;
  plugins: PluginRecord[];
}


/**
 * Load NPX MCP servers from refined JSON file
 */
async function loadNpxServers(): Promise<RegistryData | null> {
  const filePath = path.resolve(DATA_DIR, "refined/npxServers.json");
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as RegistryData;
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === "ENOENT") {
      console.warn(`[registry] npxServers.json not found at: ${filePath}`);
      return null;
    }
    throw err;
  }
}

/**
 * Load HTTP/SSE MCP servers from refined JSON file
 */
async function loadHttpServers(): Promise<RegistryData | null> {
  const filePath = path.resolve(DATA_DIR, "refined/httpServers.json");
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as RegistryData;
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === "ENOENT") {
      console.warn(`[registry] httpServers.json not found at: ${filePath}`);
      return null;
    }
    throw err;
  }
}

/**
 * Load external Docker MCP servers from refined JSON file
 */
async function loadDockerServers(): Promise<RegistryData | null> {
  const filePath = path.resolve(DATA_DIR, "refined/dockerServers.json");
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as RegistryData;
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === "ENOENT") {
      console.warn(`[registry] dockerServers.json not found at: ${filePath}`);
      return null;
    }
    throw err;
  }
}

/**
 * Load GHCR containerized MCP servers from refined JSON file
 */
async function loadGhcrServers(): Promise<RegistryData | null> {
  const filePath = path.resolve(DATA_DIR, "refined/ghcrServers.json");
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as RegistryData;
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === "ENOENT") {
      console.warn(`[registry] ghcrServers.json not found at: ${filePath}`);
      return null;
    }
    throw err;
  }
}

/**
 * Load GOAT plugins from JSON file
 */
async function loadGoatPlugins(): Promise<PluginRegistryData | null> {
  const filePath = path.resolve(__dirname, "../../../data/goatPlugins.json");
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as PluginRegistryData;
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === "ENOENT") {
      console.warn(`[registry] goatPlugins.json not found at: ${filePath}. Run sync-plugins script first.`);
      return null;
    }
    throw err;
  }
}

/**
 * Load ElizaOS plugins from JSON file
 */
async function loadElizaPlugins(): Promise<PluginRegistryData | null> {
  const filePath = path.resolve(__dirname, "../../../data/elizaPlugins.json");
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as PluginRegistryData;
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === "ENOENT") {
      console.warn(`[registry] elizaPlugins.json not found at: ${filePath}. Run sync-plugins script first.`);
      return null;
    }
    throw err;
  }
}

/** GOAT plugins with live execution support */
const EXECUTABLE_GOAT_PLUGINS = new Set([
  "erc20", "coingecko", "uniswap", "1inch", "jupiter",
  "polymarket", "farcaster", "ens", "opensea",
]);

/**
 * Normalize all sources into unified records with deduplication
 */
function normalizeRegistry(
  mcpData: RegistryData | null,
  goatData: PluginRegistryData | null,
  elizaData: PluginRegistryData | null,
  internalServers: InternalMcpServer[]
): UnifiedServerRecord[] {
  const records: UnifiedServerRecord[] = [];

  // Add GOAT plugins first (highest priority)
  if (goatData?.plugins) {
    for (const p of goatData.plugins) {
      const canonicalKey = normalizeToCanonicalKey(p.slug, "goat");
      const isExecutable = EXECUTABLE_GOAT_PLUGINS.has(canonicalKey);

      records.push({
        registryId: `goat:${cleanSlug(p.name)}`,
        origin: "goat",
        type: "plugin",
        sources: ["goat"],
        canonicalKey,
        name: cleanSlug(p.name),
        namespace: p.namespace,
        slug: p.slug,
        description: p.description,
        attributes: ["category:defi", "hosting:remote-capable", "executable:goat"],
        repoUrl: p.repository,
        uiUrl: p.homepage,
        category: "defi",
        tags: p.keywords,
        toolCount: 0,
        available: true,
        executable: isExecutable,
        raw: p as unknown as McpServer,
      });
    }
  }

  // Add ElizaOS plugins (second priority)
  if (elizaData?.plugins) {
    for (const p of elizaData.plugins) {
      const canonicalKey = normalizeToCanonicalKey(p.slug, "eliza");

      // Derive category from keywords
      let category = "utility";
      if (p.keywords.includes("social") || p.keywords.includes("chat")) category = "social";
      else if (p.keywords.includes("blockchain") || p.keywords.includes("web3")) category = "blockchain";
      else if (p.keywords.includes("ai") || p.keywords.includes("llm")) category = "ai";

      records.push({
        registryId: `eliza:${cleanSlug(p.name)}`,
        origin: "eliza",
        type: "plugin",
        sources: ["eliza"],
        canonicalKey,
        name: cleanSlug(p.name),
        namespace: p.namespace,
        slug: p.slug,
        description: p.description,
        attributes: [`category:${category}`, "hosting:remote-capable"],
        repoUrl: p.repository,
        category,
        tags: p.keywords,
        toolCount: 0,
        available: true,
        executable: false, // ElizaOS execution coming in future
        raw: p as unknown as McpServer,
      });
    }
  }

  // Add internal servers last (but they get deduplicated as highest priority)
  for (const s of internalServers) {
    const missing = getMissingEnvForServer(s);
    const canonicalKey = `internal:${s.slug}`; // Unique prefix to avoid dedup

    records.push({
      registryId: `internal:${s.id}`,
      origin: "internal",
      type: "plugin",
      sources: ["internal"],
      canonicalKey,
      name: s.name,
      namespace: s.namespace,
      slug: s.slug,
      description: s.description,
      attributes: s.attributes,
      repoUrl: undefined,
      uiUrl: undefined,
      category: s.category,
      tags: s.tags,
      toolCount: s.tools.length,
      tools: s.tools,
      available: isInternalServerAvailable(s),
      executable: isInternalServerAvailable(s),
      connectorId: s.entryPoint?.connectorId,
      missingEnv: missing.length > 0 ? missing : undefined,
      raw: s,
    });
  }

  // Add Mcp servers (lowest priority)
  if (mcpData?.servers) {
    for (const s of mcpData.servers) {
      const attrs = Array.isArray(s.attributes) ? s.attributes : [];
      const desc = typeof s.description === "string" ? s.description : "(no description)";
      const canonicalKey = normalizeToCanonicalKey(s.slug, "mcp");

      // Extract category from attributes
      const categoryAttr = attrs.find((a) => a.startsWith("category:"));
      const category = categoryAttr ? categoryAttr.replace("category:", "") : undefined;

      // Generate tags from name, namespace, and description
      const tags = generateTags(s.name, s.namespace, desc);

      // Determine executability:
      // All MCP servers are potentially executable via the MCP server
      // The MCP server handles dynamic spawning
      const isExecutable = true;

      records.push({
        registryId: `mcp:${cleanSlug(s.name || s.slug || s.id)}`,
        origin: "mcp",
        type: "plugin",
        sources: ["mcp"],  // All MCP servers are treated as MCP origin
        canonicalKey,
        name: cleanSlug(s.name || s.slug || s.id),
        namespace: s.namespace,
        slug: s.slug,
        description: desc,
        attributes: attrs,
        repoUrl: s.repository?.url || undefined,
        uiUrl: s.url,
        category,
        tags,
        toolCount: s.tools?.length || 0,
        tools: s.tools,
        available: true,
        executable: isExecutable, // Executable if has valid slug for on-demand connection
        // Transport metadata from official MCP Registry
        transport: s.transport,
        image: s.image,
        remoteUrl: s.remoteUrl,
        raw: s,
      });
    }
  }

  // Apply deduplication
  return deduplicateRecords(records);
}

/**
 * Generate search tags from server metadata
 */
function generateTags(name: string, namespace: string, description: string): string[] {
  const tags = new Set<string>();

  // Add namespace
  if (namespace) {
    tags.add(namespace.toLowerCase());
  }

  // Add words from name
  const nameWords = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w.length > 2);
  nameWords.forEach((w) => tags.add(w));

  // Add common keywords from description
  const descLower = description.toLowerCase();
  const keywords = [
    // General tech
    "api", "database", "file", "storage", "cloud", "ai", "ml",
    "web", "browser", "automation", "git", "code", "dev",
    // Productivity
    "slack", "discord", "notion", "google", "aws", "azure",
    // Infrastructure
    "docker", "kubernetes", "postgres", "mysql", "mongodb",
    "redis", "graphql", "rest", "http", "websocket",
    // DeFi & Crypto
    "defi", "swap", "bridge", "dex", "nft", "token", "wallet",
    "ethereum", "solana", "polygon", "avalanche", "arbitrum",
    "uniswap", "aave", "compound", "staking", "yield", "lending",
    "trading", "exchange", "liquidity", "amm", "perps",
    // Social
    "twitter", "telegram", "farcaster", "social", "chat",
    // AI
    "llm", "gpt", "claude", "gemini", "openai", "anthropic",
  ];
  for (const kw of keywords) {
    if (descLower.includes(kw)) {
      tags.add(kw);
    }
  }

  return Array.from(tags);
}

/**
 * Resolve a server by flexible ID matching
 * Tries multiple strategies to find a server:
 * 1. Exact registryId match
 * 2. With mcp: prefix added
 * 3. By slug field
 * 4. By cleanSlug of name
 * 5. Partial slug match (e.g., "perplexity" matches "perplexity-web-search")
 */
export async function resolveServerByFlexibleId(
  serverId: string
): Promise<UnifiedServerRecord | undefined> {
  const registry = await getRegistry();
  const normalizedInput = serverId.toLowerCase().replace(/^mcp[:-]/, '');

  // 1. Exact registryId match
  let server = registry.find(s => s.registryId === serverId);
  if (server) {
    console.log(`[registry] Resolved "${serverId}" by exact registryId`);
    return server;
  }

  // 2. Try with mcp: prefix
  server = registry.find(s => s.registryId === `mcp:${serverId}`);
  if (server) {
    console.log(`[registry] Resolved "${serverId}" by mcp: prefix -> ${server.registryId}`);
    return server;
  }

  // 3. By slug field (exact)
  server = registry.find(s => s.slug === serverId || s.slug === normalizedInput);
  if (server) {
    console.log(`[registry] Resolved "${serverId}" by slug -> ${server.registryId}`);
    return server;
  }

  // 4. By name (cleanSlug comparison)
  server = registry.find(s => s.name === normalizedInput || cleanSlug(s.name) === normalizedInput);
  if (server) {
    console.log(`[registry] Resolved "${serverId}" by name/cleanSlug -> ${server.registryId}`);
    return server;
  }

  // 5. Partial slug match (e.g., "perplexity" matches "perplexity-web-search")
  // Prefer shorter slugs for more specific matches
  const partialMatches = registry
    .filter(s => s.slug.includes(normalizedInput) || s.name.includes(normalizedInput))
    .sort((a, b) => a.slug.length - b.slug.length);
  if (partialMatches.length > 0) {
    server = partialMatches[0];
    console.log(`[registry] Resolved "${serverId}" by partial match -> ${server.registryId} (${partialMatches.length} candidates)`);
    return server;
  }

  // 6. Try with common suffixes removed/added
  const variations = [
    `${normalizedInput}-web-search`,
    `${normalizedInput}-search`,
    `${normalizedInput}-mcp`,
    normalizedInput.replace(/-web-search$/, ''),
    normalizedInput.replace(/-search$/, ''),
    normalizedInput.replace(/-mcp$/, ''),
  ];
  for (const variation of variations) {
    server = registry.find(s => s.slug === variation || s.name === variation);
    if (server) {
      console.log(`[registry] Resolved "${serverId}" by variation "${variation}" -> ${server.registryId}`);
      return server;
    }
  }

  console.warn(`[registry] Could not resolve server: ${serverId}`);
  return undefined;
}

/**
 * Get spawn configuration for an MCP server
 * Dynamically looks up server in registry and returns spawn config based on transport type
 */
export async function getServerSpawnConfig(serverId: string): Promise<{
  transport: "stdio" | "http" | "docker";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  image?: string;
  remoteUrl?: string;
} | null> {
  // Use flexible resolution instead of direct lookup
  const server = await resolveServerByFlexibleId(serverId);

  if (!server) {
    console.warn(`[registry] Server not found after flexible resolution: ${serverId}`);
    return null;
  }

  // Return config based on transport type
  if (server.remoteUrl) {
    // HTTP/SSE remote server
    return {
      transport: "http",
      remoteUrl: server.remoteUrl,
    };
  }

  if (server.image) {
    // Docker containerized server
    return {
      transport: "docker",
      image: server.image,
    };
  }

  // Fallback: stdio with npx
  // Try to extract package name from server metadata
  let packageName: string | undefined;

  // Type guard: packages only exist on McpServer, not InternalMcpServer
  if ("packages" in server.raw && server.raw.packages && server.raw.packages.length > 0) {
    const npmPackage = server.raw.packages.find((p: any) => p.registryType === "npm" || p.registryType === "npmjs");
    const pypiPackage = server.raw.packages.find((p: any) => p.registryType === "pypi");

    if (npmPackage) {
      packageName = npmPackage.identifier;
    } else if (pypiPackage) {
      // Python package - use uvx or pipx
      return {
        transport: "stdio",
        command: "uvx",
        args: ["--from", pypiPackage.identifier, pypiPackage.identifier.split("/").pop() || pypiPackage.identifier],
        env: {},
      };
    }
  }

  // If no package metadata, try to infer from namespace/slug
  if (!packageName) {
    // Common patterns: @modelcontextprotocol/server-*, @namespace/server-*
    if (server.namespace === "modelcontextprotocol") {
      packageName = `@modelcontextprotocol/server-${server.slug}`;
    } else {
      // Generic pattern
      packageName = `@${server.namespace}/server-${server.slug}`;
    }
  }

  return {
    transport: "stdio",
    command: "npx",
    args: ["-y", packageName],
    env: {},
  };
}

/**
 * Get the unified registry (loads from disk if not cached)
 */
export async function getRegistry(): Promise<UnifiedServerRecord[]> {
  if (!REGISTRY) {
    const [npxData, httpData, dockerData, ghcrData, goatData, elizaData] = await Promise.all([
      loadNpxServers(),
      loadHttpServers(),
      loadDockerServers(),
      loadGhcrServers(),
      loadGoatPlugins(),
      loadElizaPlugins(),
    ]);
    const internalServers = getInternalServers();

    // Combine all MCP sources into one array
    const allMcpServers: McpServer[] = [];
    if (npxData?.servers) allMcpServers.push(...npxData.servers);
    if (httpData?.servers) allMcpServers.push(...httpData.servers);
    if (dockerData?.servers) allMcpServers.push(...dockerData.servers);
    if (ghcrData?.servers) allMcpServers.push(...ghcrData.servers);

    // Create combined MCP data
    const combinedMcpData: RegistryData = {
      sources: ["npx", "http", "docker", "ghcr"],
      updatedAt: new Date().toISOString(),
      count: allMcpServers.length,
      servers: allMcpServers,
    };

    REGISTRY = normalizeRegistry(combinedMcpData, goatData, elizaData, internalServers);
    REGISTRY_LOADED_AT = new Date().toISOString();

    console.log(
      `[registry] Loaded ${REGISTRY.length} servers ` +
      `(${npxData?.count || 0} npx + ${httpData?.count || 0} http + ${dockerData?.count || 0} docker + ${ghcrData?.count || 0} ghcr + ${goatData?.count || 0} goat + ${elizaData?.count || 0} eliza + ${internalServers.length} internal)`
    );
  }
  return REGISTRY;
}

/**
 * Force reload the registry from disk
 */
export async function reloadRegistry(): Promise<UnifiedServerRecord[]> {
  REGISTRY = null;
  return getRegistry();
}

/**
 * Get registry metadata
 */
export async function getRegistryMeta(): Promise<{
  totalServers: number;
  mcpServers: number;
  internalServers: number;
  goatServers: number;
  elizaServers: number;
  executableServers: number;
  deduplicatedCount: number;
  loadedAt: string | null;
}> {
  const registry = await getRegistry();

  // Count servers with multiple sources (deduplicated)
  const deduplicatedCount = registry.filter(s => s.sources.length > 1).length;

  return {
    totalServers: registry.length,
    mcpServers: registry.filter((s) => s.origin === "mcp").length,
    internalServers: registry.filter((s) => s.origin === "internal").length,
    goatServers: registry.filter((s) => s.origin === "goat").length,
    elizaServers: registry.filter((s) => s.origin === "eliza").length,
    executableServers: registry.filter((s) => s.executable).length,
    deduplicatedCount,
    loadedAt: REGISTRY_LOADED_AT,
  };
}

/**
 * Search the registry by query string
 */
export async function searchRegistry(query: string): Promise<UnifiedServerRecord[]> {
  const q = query.toLowerCase().trim();
  if (!q) {
    return getRegistry();
  }

  const registry = await getRegistry();

  // Score-based search
  const scored = registry.map((s) => {
    let score = 0;

    // Exact name match (highest)
    if (s.name.toLowerCase() === q) score += 100;
    // Name contains query
    else if (s.name.toLowerCase().includes(q)) score += 50;

    // Namespace match
    if (s.namespace.toLowerCase().includes(q)) score += 30;

    // Slug match
    if (s.slug.toLowerCase().includes(q)) score += 25;

    // Description match
    if (s.description.toLowerCase().includes(q)) score += 20;

    // Tag match
    if (s.tags.some((t) => t.includes(q))) score += 15;

    // Category match
    if (s.category?.toLowerCase().includes(q)) score += 10;

    // Repo URL match
    if (s.repoUrl?.toLowerCase().includes(q)) score += 5;

    return { server: s, score };
  });

  // Filter and sort by score
  return scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.server);
}

/**
 * Get a server by registry ID
 * Uses flexible resolution to handle various naming patterns
 */
export async function getServerByRegistryId(
  registryId: string
): Promise<UnifiedServerRecord | undefined> {
  // Use the flexible resolution function for consistent lookup
  return await resolveServerByFlexibleId(registryId);
}

/**
 * Get servers by category
 */
export async function getServersByCategory(
  category: string
): Promise<UnifiedServerRecord[]> {
  const registry = await getRegistry();
  return registry.filter((s) => s.category === category);
}

/**
 * Get servers by origin
 */
export async function getServersByOrigin(
  origin: ServerOrigin
): Promise<UnifiedServerRecord[]> {
  const registry = await getRegistry();
  return registry.filter((s) => s.origin === origin);
}

/**
 * Get all unique categories
 */
export async function getCategories(): Promise<string[]> {
  const registry = await getRegistry();
  const categories = new Set<string>();
  for (const s of registry) {
    if (s.category) {
      categories.add(s.category);
    }
  }
  return Array.from(categories).sort();
}

/**
 * Get all unique tags
 */
export async function getTags(): Promise<string[]> {
  const registry = await getRegistry();
  const tags = new Set<string>();
  for (const s of registry) {
    for (const t of s.tags) {
      tags.add(t);
    }
  }
  return Array.from(tags).sort();
}

// =============================================================================
// Express Router
// =============================================================================

/**
 * Create Express router for registry endpoints
 */
export function createRegistryRouter(): express.Router {
  const router = express.Router();

  /**
   * GET /registry
   * Root route - return all servers (backward compatibility)
   */
  router.get("/", async (req, res) => {
    try {
      const { origin, category, available, type, limit, offset } = req.query;

      let servers = await getRegistry();

      // Filter by type (agent or plugin)
      if (typeof type === "string" && (type === "agent" || type === "plugin")) {
        servers = servers.filter((s) => s.type === type);
      }

      // Filter by origin (supports comma-separated list)
      // By default, exclude internal servers unless explicitly requested
      if (typeof origin === "string" && origin) {
        const validOrigins: ServerOrigin[] = ["mcp", "internal", "goat", "eliza"];
        const origins = origin.split(",").filter((o): o is ServerOrigin =>
          validOrigins.includes(o as ServerOrigin)
        );
        if (origins.length > 0) {
          servers = servers.filter((s) => origins.includes(s.origin));
        }
      } else {
        // Default: exclude internal servers from public listings
        servers = servers.filter((s) => s.origin !== "internal");
      }

      // Filter by category
      if (typeof category === "string" && category) {
        servers = servers.filter((s) => s.category === category);
      }

      // Filter by availability
      if (available === "true") {
        servers = servers.filter((s) => s.available);
      } else if (available === "false") {
        servers = servers.filter((s) => !s.available);
      }

      // Pagination
      const limitNum = typeof limit === "string" ? parseInt(limit, 10) : undefined;
      const offsetNum = typeof offset === "string" ? parseInt(offset, 10) : 0;

      if (limitNum && limitNum > 0) {
        servers = servers.slice(offsetNum, offsetNum + limitNum);
      } else if (offsetNum > 0) {
        servers = servers.slice(offsetNum);
      }

      res.json(servers);
    } catch (err) {
      console.error("[registry] / error:", err);
      res.status(500).json({ error: "Internal error" });
    }
  });

  /**
   * GET /registry/servers
   * List all servers with optional filtering
   */
  router.get("/servers", async (req, res) => {
    try {
      const { origin, category, available, type, limit, offset } = req.query;

      let servers = await getRegistry();

      // Filter by type (agent or plugin)
      if (typeof type === "string" && (type === "agent" || type === "plugin")) {
        servers = servers.filter((s) => s.type === type);
      }

      // Filter by origin (supports comma-separated list)
      // By default, exclude internal servers unless explicitly requested
      if (typeof origin === "string" && origin) {
        const validOrigins: ServerOrigin[] = ["mcp", "internal", "goat", "eliza"];
        const origins = origin.split(",").filter((o): o is ServerOrigin =>
          validOrigins.includes(o as ServerOrigin)
        );
        if (origins.length > 0) {
          servers = servers.filter((s) => origins.includes(s.origin));
        }
      } else {
        // Default: exclude internal servers from public listings
        servers = servers.filter((s) => s.origin !== "internal");
      }

      // Filter by category
      if (typeof category === "string" && category) {
        servers = servers.filter((s) => s.category === category);
      }

      // Filter by availability
      if (available === "true") {
        servers = servers.filter((s) => s.available);
      }

      // Pagination - no hard cap, return all if limit not specified
      const offsetNum = parseInt(offset as string, 10) || 0;
      const limitNum = parseInt(limit as string, 10) || 0;
      const paginated = limitNum > 0 ? servers.slice(offsetNum, offsetNum + limitNum) : servers.slice(offsetNum);

      res.json({
        total: servers.length,
        offset: offsetNum,
        limit: limitNum,
        servers: paginated,
      });
    } catch (err) {
      console.error("[registry] /servers error:", err);
      res.status(500).json({ error: "Internal error" });
    }
  });

  /**
   * GET /registry/servers/search
   * Search servers by query
   */
  router.get("/servers/search", async (req, res) => {
    const q = String(req.query.q || "").trim();
    if (!q) {
      res.status(400).json({ error: "Missing q parameter" });
      return;
    }

    try {
      const results = await searchRegistry(q);
      const limit = parseInt(req.query.limit as string, 10) || 0;

      res.json({
        query: q,
        total: results.length,
        servers: limit > 0 ? results.slice(0, limit) : results,
      });
    } catch (err) {
      console.error("[registry] /servers/search error:", err);
      res.status(500).json({ error: "Internal error" });
    }
  });

  /**
   * GET /registry/servers/:registryId
   * Get a specific server by registry ID
   */
  router.get("/servers/:registryId", async (req, res) => {
    try {
      // Handle URL-encoded registry IDs (e.g., "mcp%3Aabc123")
      const registryId = decodeURIComponent(req.params.registryId);
      const server = await getServerByRegistryId(registryId);

      if (!server) {
        res.status(404).json({ error: "Server not found" });
        return;
      }

      res.json(server);
    } catch (err) {
      console.error("[registry] /servers/:id error:", err);
      res.status(500).json({ error: "Internal error" });
    }
  });

  /**
   * GET /registry/categories
   * Get all unique categories
   */
  router.get("/categories", async (_req, res) => {
    try {
      const categories = await getCategories();
      res.json({ categories });
    } catch (err) {
      console.error("[registry] /categories error:", err);
      res.status(500).json({ error: "Internal error" });
    }
  });

  /**
   * GET /registry/tags
   * Get all unique tags
   */
  router.get("/tags", async (_req, res) => {
    try {
      const tags = await getTags();
      res.json({ tags });
    } catch (err) {
      console.error("[registry] /tags error:", err);
      res.status(500).json({ error: "Internal error" });
    }
  });

  /**
   * GET /registry/meta
   * Get registry metadata
   */
  router.get("/meta", async (_req, res) => {
    try {
      const meta = await getRegistryMeta();
      res.json(meta);
    } catch (err) {
      console.error("[registry] /meta error:", err);
      res.status(500).json({ error: "Internal error" });
    }
  });

  /**
   * POST /registry/reload
   * Force reload the registry from disk
   */
  router.post("/reload", async (_req, res) => {
    try {
      await reloadRegistry();
      const meta = await getRegistryMeta();
      res.json({
        message: "Registry reloaded",
        ...meta
      });
    } catch (err) {
      console.error("[registry] /reload error:", err);
      res.status(500).json({ error: "Failed to reload registry" });
    }
  });

  return router;
}

