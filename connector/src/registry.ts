/**
 * MCP Registry Module
 * 
 * Loads servers from:
 * - Glama dump (data/mcpServers.json)
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

/** Glama MCP server from the JSON dump */
export interface GlamaMcpServer {
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
  [key: string]: unknown;
}

/** Registry data from the JSON dump */
export interface RegistryData {
  sources: string[];
  updatedAt: string;
  count: number;
  servers: GlamaMcpServer[];
}

/** Server origin types */
export type ServerOrigin = "glama" | "internal" | "goat" | "eliza";

/** Record type: agent (autonomous AI agents) or plugin (tools/connectors) */
export type RecordType = "agent" | "plugin";

/** Unified server record for the registry */
export interface UnifiedServerRecord {
  /** Unique registry ID: "glama:{id}", "internal:{id}", "goat:{id}", or "eliza:{id}" */
  registryId: string;
  /** Primary origin: glama, internal, goat, or eliza */
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
  /** Raw server data */
  raw: GlamaMcpServer | InternalMcpServer;
}

// =============================================================================
// Deduplication Logic
// =============================================================================

/** Priority order for deduplication (lower = higher priority) */
const ORIGIN_PRIORITY: Record<ServerOrigin, number> = {
  internal: 1, // Highest: our own tools
  goat: 2,      // Second: has live execution
  eliza: 3,    // Third: rich metadata
  glama: 4,    // Lowest: external MCP servers
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
 * Deduplicate records by canonical key.
 * Merges metadata and keeps the highest-priority source as primary.
 */
function deduplicateRecords(records: UnifiedServerRecord[]): UnifiedServerRecord[] {
  const byCanonicalKey = new Map<string, UnifiedServerRecord[]>();
  
  // Group by canonical key
  for (const record of records) {
    const key = record.canonicalKey;
    const existing = byCanonicalKey.get(key) || [];
    existing.push(record);
    byCanonicalKey.set(key, existing);
  }
  
  const deduplicated: UnifiedServerRecord[] = [];
  let mergedCount = 0;
  
  for (const [key, group] of byCanonicalKey) {
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
 * Load Glama dump from JSON file
 */
async function loadGlamaDump(): Promise<RegistryData | null> {
  const filePath = path.resolve(__dirname, "../data/mcpServers.json");
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as RegistryData;
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === "ENOENT") {
      console.warn("[registry] mcpServers.json not found. Run sync script first.");
      return null;
    }
    throw err;
  }
}

/**
 * Load GOAT plugins from JSON file
 */
async function loadGoatPlugins(): Promise<PluginRegistryData | null> {
  const filePath = path.resolve(__dirname, "../data/goatPlugins.json");
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as PluginRegistryData;
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === "ENOENT") {
      console.warn("[registry] goatPlugins.json not found. Run sync-plugins script first.");
      return null;
    }
    throw err;
  }
}

/**
 * Load ElizaOS plugins from JSON file
 */
async function loadElizaPlugins(): Promise<PluginRegistryData | null> {
  const filePath = path.resolve(__dirname, "../data/elizaPlugins.json");
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as PluginRegistryData;
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === "ENOENT") {
      console.warn("[registry] elizaPlugins.json not found. Run sync-plugins script first.");
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
  glamaData: RegistryData | null,
  goatData: PluginRegistryData | null,
  elizaData: PluginRegistryData | null,
  internal: InternalMcpServer[]
): UnifiedServerRecord[] {
  const records: UnifiedServerRecord[] = [];

  // Add GOAT plugins first (highest priority)
  if (goatData?.plugins) {
    for (const p of goatData.plugins) {
      const canonicalKey = normalizeToCanonicalKey(p.slug, "goat");
      const isExecutable = EXECUTABLE_GOAT_PLUGINS.has(canonicalKey);
      
      records.push({
        registryId: `goat:${p.id}`,
        origin: "goat",
        type: "plugin",
        sources: ["goat"],
        canonicalKey,
        name: p.name,
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
        raw: p as unknown as GlamaMcpServer,
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
        registryId: `eliza:${p.id}`,
        origin: "eliza",
        type: "plugin",
        sources: ["eliza"],
        canonicalKey,
        name: p.name,
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
        raw: p as unknown as GlamaMcpServer,
      });
    }
  }

  // Add internal servers (third priority, never deduplicated)
  for (const s of internal) {
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

  // Add Glama servers (lowest priority)
  if (glamaData?.servers) {
    for (const s of glamaData.servers) {
      const attrs = Array.isArray(s.attributes) ? s.attributes : [];
      const desc = typeof s.description === "string" ? s.description : "(no description)";
      const canonicalKey = normalizeToCanonicalKey(s.slug, "glama");
      
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
        registryId: `glama:${s.id}`,
        origin: "glama",
        type: "plugin",
        sources: ["glama"],  // All MCP servers are treated as glama origin
        canonicalKey,
        name: s.name || s.slug || s.id,
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
 * Get the unified registry (loads from disk if not cached)
 */
export async function getRegistry(): Promise<UnifiedServerRecord[]> {
  if (!REGISTRY) {
    const [glamaData, goatData, elizaData] = await Promise.all([
      loadGlamaDump(),
      loadGoatPlugins(),
      loadElizaPlugins(),
    ]);
    const internalServers = getInternalServers();
    
    REGISTRY = normalizeRegistry(glamaData, goatData, elizaData, internalServers);
    REGISTRY_LOADED_AT = new Date().toISOString();
    
    console.log(
      `[registry] Loaded ${REGISTRY.length} servers ` +
      `(${glamaData?.count || 0} glama + ${goatData?.count || 0} goat + ${elizaData?.count || 0} eliza + ${internalServers.length} internal)`
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
  glamaServers: number;
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
    glamaServers: registry.filter((s) => s.origin === "glama").length,
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
 */
export async function getServerByRegistryId(
  registryId: string
): Promise<UnifiedServerRecord | undefined> {
  const registry = await getRegistry();
  return registry.find((s) => s.registryId === registryId);
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
      if (typeof origin === "string" && origin) {
        const validOrigins: ServerOrigin[] = ["glama", "internal", "goat", "eliza"];
        const origins = origin.split(",").filter((o): o is ServerOrigin => 
          validOrigins.includes(o as ServerOrigin)
        );
        if (origins.length > 0) {
          servers = servers.filter((s) => origins.includes(s.origin));
        }
      }
      
      // Filter by category
      if (typeof category === "string" && category) {
        servers = servers.filter((s) => s.category === category);
      }
      
      // Filter by availability
      if (available === "true") {
        servers = servers.filter((s) => s.available);
      }
      
      // Pagination
      const offsetNum = parseInt(offset as string, 10) || 0;
      const limitNum = Math.min(parseInt(limit as string, 10) || 50, 200);
      const paginated = servers.slice(offsetNum, offsetNum + limitNum);
      
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
      const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);
      
      res.json({
        query: q,
        total: results.length,
        servers: results.slice(0, limit),
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
      // Handle URL-encoded registry IDs (e.g., "glama%3Aabc123")
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

