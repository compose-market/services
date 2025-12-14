/**
 * MCP-to-AgentCard Builder
 * 
 * Converts MCP server metadata + tools/list into ComposeAgentCard format.
 * Uses existing ThirdWeb setup from shared/thirdweb.ts for payment config.
 */
import type {
  ComposeAgentCard,
  ComposeAgentSkill,
  ComposePaymentMethod,
  ComposeSupportedInterface,
} from "./schema.js";
import { DEFAULT_PAYMENT_CONFIG, THIRDWEB_CHAIN_IDS } from "./schema.js";
import type { UnifiedServerRecord, GlamaMcpServer } from "./registry.js";
import type { InternalMcpServer } from "./internal.js";

/** Options for building agent cards */
export interface BuildAgentCardOptions {
  /** Base URL for Compose Market agents */
  baseUrl?: string;
  
  /** Default payee address (treasury wallet) */
  payeeAddress?: string;
  
  /** Default price per call in USDC wei (1 = 0.000001 USDC) */
  basePricePerCall?: string;
  
  /** Whether to include x402 payment config */
  enablePayments?: boolean;
  
  /** Network chain ID */
  networkChainId?: string;
  
  /** USDC contract address */
  usdcAddress?: string;
}

/** Default builder options */
const DEFAULT_OPTIONS: Required<BuildAgentCardOptions> = {
  baseUrl: "https://compose.market/agents/mcp",
  payeeAddress: process.env.TREASURY_SERVER_WALLET_PUBLIC || "0x0000000000000000000000000000000000000000",
  basePricePerCall: "1000", // 0.001 USDC per call
  enablePayments: false, // Disabled by default for external servers
  networkChainId: DEFAULT_PAYMENT_CONFIG.network,
  usdcAddress: DEFAULT_PAYMENT_CONFIG.assetAddress,
};

/**
 * Build a ComposeAgentCard from a unified registry record
 */
export function buildAgentCardFromRegistry(
  record: UnifiedServerRecord,
  options: BuildAgentCardOptions = {}
): ComposeAgentCard {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  
  // Build skills from tools
  const skills: ComposeAgentSkill[] = buildSkillsFromTools(
    record.tools || [],
    record.registryId
  );
  
  // Build payment methods if enabled
  const payments: ComposePaymentMethod[] = [];
  if (opts.enablePayments && opts.payeeAddress !== "0x0000000000000000000000000000000000000000") {
    payments.push({
      id: "x402-default",
      method: "x402",
      network: opts.networkChainId,
      assetSymbol: "USDC",
      assetAddress: opts.usdcAddress as `0x${string}`,
      payee: opts.payeeAddress as `0x${string}`,
      x402: {
        scheme: "upto",
      },
    });
    
    // Add pricing to skills
    for (const skill of skills) {
      skill.pricing = {
        unit: "call",
        amount: opts.basePricePerCall,
        paymentMethodId: "x402-default",
      };
    }
  }
  
  // Build supported interfaces
  const agentUrl = `${opts.baseUrl}/${encodeURIComponent(record.registryId)}`;
  const supportedInterfaces: ComposeSupportedInterface[] = [
    {
      protocolBinding: "HTTP+JSON",
      url: agentUrl,
      version: "1.0.0",
    },
  ];
  
  // Add MCP interface for external servers
  if (record.origin === "glama" && record.raw) {
    const glamaServer = record.raw as GlamaMcpServer;
    if (glamaServer.url) {
      supportedInterfaces.push({
        protocolBinding: "MCP",
        url: glamaServer.url,
        version: new Date().toISOString().slice(0, 10),
      });
    }
  }
  
  // Build capabilities from attributes and tags
  const capabilities = [
    ...record.attributes,
    ...record.tags.map((t) => `tag:${t}`),
  ];
  if (record.origin === "internal") {
    capabilities.push("compose:internal");
  }
  
  // Build MCP binding for external servers
  let mcp: ComposeAgentCard["mcp"];
  if (record.origin === "glama") {
    const glamaServer = record.raw as GlamaMcpServer;
    mcp = {
      transport: glamaServer.attributes?.includes("hosting:remote-capable")
        ? "remote-http"
        : "stdio",
      endpoint: glamaServer.repository?.url || glamaServer.url || record.registryId,
    };
  }
  
  // Build author info
  let author: ComposeAgentCard["author"];
  if (record.namespace) {
    author = {
      name: record.namespace,
      github: record.repoUrl?.includes("github.com") ? record.repoUrl : undefined,
    };
  }
  
  return {
    schemaVersion: "1.0.0",
    id: `mcp://${record.namespace}/${record.slug}`,
    name: record.name,
    description: record.description,
    url: agentUrl,
    version: "0.0.1",
    iconUrl: undefined,
    author,
    capabilities,
    supportedInterfaces,
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json", "text/plain"],
    skills,
    payments,
    mcp,
  };
}

/**
 * Build skills from MCP tools metadata
 */
function buildSkillsFromTools(
  tools: Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  }>,
  serverIdPrefix: string
): ComposeAgentSkill[] {
  if (!tools || tools.length === 0) {
    // Create a generic "call" skill for servers without tool metadata
    return [
      {
        id: `${serverIdPrefix}/call`,
        name: "call",
        description: "Execute a command on this server",
        tags: [],
        inputModes: ["application/json"],
        outputModes: ["application/json", "text/plain"],
        streaming: false,
        inputSchema: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description: "Command to execute",
            },
            args: {
              type: "object",
              description: "Command arguments",
            },
          },
          required: ["command"],
        },
      },
    ];
  }
  
  return tools.map((tool) => ({
    id: `${serverIdPrefix}/${tool.name}`,
    name: tool.name,
    description: tool.description || `Execute ${tool.name}`,
    tags: extractTagsFromTool(tool),
    inputModes: ["application/json"],
    outputModes: ["application/json", "text/plain"],
    streaming: false,
    inputSchema: tool.inputSchema || { type: "object" },
  }));
}

/**
 * Extract tags from tool metadata
 */
function extractTagsFromTool(tool: {
  name: string;
  description?: string;
}): string[] {
  const tags = new Set<string>();
  
  // Extract words from tool name
  const nameWords = tool.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w.length > 2);
  nameWords.forEach((w) => tags.add(w));
  
  // Extract keywords from description
  if (tool.description) {
    const descLower = tool.description.toLowerCase();
    const keywords = [
      "create", "read", "update", "delete", "list", "get", "set",
      "search", "query", "send", "receive", "upload", "download",
    ];
    for (const kw of keywords) {
      if (descLower.includes(kw)) {
        tags.add(kw);
      }
    }
  }
  
  return Array.from(tags);
}

/**
 * Build a ComposeAgentCard from an internal server
 */
export function buildAgentCardFromInternal(
  server: InternalMcpServer,
  options: BuildAgentCardOptions = {}
): ComposeAgentCard {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  
  // Build skills from internal tools
  const skills: ComposeAgentSkill[] = server.tools.map((tool) => ({
    id: `internal:${server.id}/${tool.name}`,
    name: tool.name,
    description: tool.description,
    tags: server.tags,
    inputModes: ["application/json"],
    outputModes: ["application/json", "text/plain"],
    streaming: false,
    inputSchema: tool.inputSchema,
  }));
  
  // Build payment methods if enabled
  const payments: ComposePaymentMethod[] = [];
  const isX402Enabled = server.attributes.includes("x402:enabled");
  
  if ((opts.enablePayments || isX402Enabled) && 
      opts.payeeAddress !== "0x0000000000000000000000000000000000000000") {
    payments.push({
      id: "x402-default",
      method: "x402",
      network: opts.networkChainId,
      assetSymbol: "USDC",
      assetAddress: opts.usdcAddress as `0x${string}`,
      payee: opts.payeeAddress as `0x${string}`,
      x402: {
        scheme: "upto",
      },
    });
    
    // Add pricing to skills
    for (const skill of skills) {
      skill.pricing = {
        unit: "call",
        amount: opts.basePricePerCall,
        paymentMethodId: "x402-default",
      };
    }
  }
  
  // Build endpoint URL based on entry point type
  let endpointUrl: string;
  switch (server.entryPoint.type) {
    case "lambda":
      endpointUrl = `${process.env.VITE_API_URL || "https://api.compose.market"}${server.entryPoint.endpoint}`;
      break;
    case "connector":
      endpointUrl = `${opts.baseUrl}/${encodeURIComponent(`internal:${server.id}`)}`;
      break;
    default:
      endpointUrl = `${opts.baseUrl}/${encodeURIComponent(`internal:${server.id}`)}`;
  }
  
  const supportedInterfaces: ComposeSupportedInterface[] = [
    {
      protocolBinding: "HTTP+JSON",
      url: endpointUrl,
      version: "1.0.0",
    },
  ];
  
  return {
    schemaVersion: "1.0.0",
    id: `internal://${server.namespace}/${server.slug}`,
    name: server.name,
    description: server.description,
    url: endpointUrl,
    version: "0.1.0",
    iconUrl: undefined,
    author: {
      name: "Compose Market",
      website: "https://compose.market",
    },
    capabilities: [
      ...server.attributes,
      ...server.tags.map((t) => `tag:${t}`),
      "compose:internal",
    ],
    supportedInterfaces,
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json", "text/plain"],
    skills,
    payments,
  };
}

/**
 * Batch build agent cards from registry
 */
export async function buildAgentCardsFromRegistry(
  records: UnifiedServerRecord[],
  options: BuildAgentCardOptions = {}
): Promise<ComposeAgentCard[]> {
  return records.map((record) => buildAgentCardFromRegistry(record, options));
}

