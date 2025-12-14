/**
 * ComposeAgentCard Schema
 * 
 * Zod schemas for A2A + MCP + x402 + ERC-8004 compatible agent cards.
 * Fully aligned with ThirdWeb x402 PaymentArgs structure.
 */
import { z } from "zod";

// =============================================================================
// JSON Schema (permissive placeholder)
// =============================================================================

/** Permissive JSON Schema type */
export const jsonSchemaZ = z.record(z.string(), z.unknown());

// =============================================================================
// ThirdWeb x402 Payment Method
// =============================================================================

/**
 * x402 Payment Method - matches ThirdWeb's PaymentArgs structure
 * 
 * ThirdWeb pattern:
 * ```ts
 * const paymentArgs: PaymentArgs = {
 *   facilitator: twFacilitator,
 *   method: "POST",
 *   network: avalancheFuji, // or arbitrum, etc.
 *   scheme: "upto",
 *   price: { amount: "1000", asset: { address: "0x..." } },
 *   resourceUrl: "...",
 *   paymentData: "...",
 * }
 * ```
 */
export const paymentMethodSchema = z.object({
  /** Local ID for referencing from skills.pricing.paymentMethodId */
  id: z.string().min(1),

  /** Payment method type (x402 for ThirdWeb) */
  method: z.enum(["x402", "ap2", "custom", "free"]),

  /** ThirdWeb chain ID as string (e.g., "43113" for Fuji, "43114" for Avalanche, "42161" for Arbitrum) */
  network: z.string().min(1),

  /** Asset symbol (e.g., "USDC") */
  assetSymbol: z.string().min(1),

  /** Asset contract address (e.g., from USDC_ADDRESSES) */
  assetAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Invalid EVM address"),

  /** Payee wallet address (serverWalletAddress pattern) */
  payee: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Invalid EVM address"),

  /** x402-specific configuration */
  x402: z
    .object({
      /** Payment scheme: "exact" or "upto" (ThirdWeb x402 schemes) */
      scheme: z.enum(["exact", "upto"]).default("upto"),
      
      /** Optional facilitator URL for remote facilitator */
      facilitatorUrl: z.string().url().optional(),

      /** Optional facilitator ID */
      facilitatorId: z.string().min(1).optional(),
    })
    .optional(),

  /** Free-form extensions for AP2, Kite, etc. */
  extensions: z.record(z.string(), z.unknown()).optional(),
});

// =============================================================================
// Agent Skill (Callable Capability)
// =============================================================================

/**
 * Per-skill pricing - compatible with ThirdWeb settlePayment()
 */
export const skillPricingSchema = z.object({
  /** Price unit: "call", "token", "second", "row", "mb", etc. */
  unit: z.string().min(1),

  /** Price amount in smallest unit (wei for USDC = 1e-6 USDC) */
  amount: z.string().min(1),

  /** Reference to payments[].id */
  paymentMethodId: z.string().min(1).optional(),

  /** Optional pricing model extensions */
  model: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Skill authentication config
 */
export const skillAuthSchema = z.object({
  /** Auth type: "none", "apiKey", "oauth2", "userWallet", "agentWallet" */
  type: z.string().min(1),

  /** OAuth-style scopes or logical privileges */
  scopes: z.array(z.string().min(1)).optional(),

  /** If true, requires explicit user consent before use */
  requiresUserConsent: z.boolean().optional(),
});

/**
 * Single callable capability exposed by the agent
 */
export const agentSkillSchema = z.object({
  /** Globally unique skill ID (e.g., "mcp://notion/tasks.create") */
  id: z.string().min(1),

  /** Human-readable name */
  name: z.string().min(1),

  /** When should an agent call this skill? */
  description: z.string().min(1),

  /** LLM hint tags */
  tags: z.array(z.string().min(1)).default([]),

  /** A2A-style input MIME types */
  inputModes: z.array(z.string().min(1)).default(["application/json"]),

  /** A2A-style output MIME types */
  outputModes: z
    .array(z.string().min(1))
    .default(["application/json", "text/plain"]),

  /** Whether streaming is supported */
  streaming: z.boolean().default(false),

  /** Strict JSON schema for input - mapped from MCP tool.inputSchema */
  inputSchema: jsonSchemaZ,

  /** Optional JSON schema for output */
  outputSchema: jsonSchemaZ.optional(),

  /** Example payloads for documentation and few-shot */
  examples: z
    .array(
      z.object({
        description: z.string().optional(),
        input: z.unknown(),
        output: z.unknown().optional(),
      })
    )
    .optional(),

  /** Authentication requirements */
  auth: skillAuthSchema.optional(),

  /** x402 pricing for this skill (optional, overrides card default) */
  pricing: skillPricingSchema.optional(),
});

// =============================================================================
// ERC-8004 On-chain Identity
// =============================================================================

/**
 * ERC-8004 endpoint descriptor
 */
export const onchainEndpointSchema = z.object({
  /** Endpoint name: "A2A", "MCP", "HTTP", etc. */
  name: z.string().min(1),

  /** Endpoint URL or identifier */
  endpoint: z.string().min(1),

  /** Protocol version */
  version: z.string().min(1).optional(),
});

/**
 * ERC-8004 Identity hook - compatible with ThirdWeb Deploy
 */
export const onchainIdentitySchema = z.object({
  /** Chain ID of the Identity Registry (e.g., "43114" for Avalanche) */
  registryChainId: z.string().min(1),

  /** ERC-8004 Identity Registry contract address (deployed via ThirdWeb) */
  registryAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Invalid EVM address"),

  /** Agent's ERC-8004 token ID / agent ID */
  agentId: z.string().min(1),

  /** Registration document location (IPFS URI) */
  registrationUri: z.string().min(1).optional(),

  /** A2A/MCP endpoints for the registration */
  endpoints: z.array(onchainEndpointSchema).default([]),
});

// =============================================================================
// Supported Interface / Protocol Binding
// =============================================================================

/**
 * Supported protocol binding (A2A, MCP, HTTP+JSON)
 */
export const supportedInterfaceSchema = z.object({
  /** Protocol binding: "A2A", "HTTP+JSON", "MCP", etc. */
  protocolBinding: z.string().min(1),

  /** Endpoint URL */
  url: z.string().min(1),

  /** Protocol version */
  version: z.string().min(1).optional(),
});

// =============================================================================
// MCP Binding
// =============================================================================

/**
 * MCP server binding - how to connect to the underlying MCP server
 */
export const mcpBindingSchema = z.object({
  /** Transport type: "remote-http", "remote-sse", "stdio", "docker" */
  transport: z.string().min(1),

  /** MCP server endpoint or command */
  endpoint: z.string().min(1),

  /** Raw mcp.json config fragment for export */
  clientConfigFragment: z.unknown().optional(),
});

// =============================================================================
// ComposeAgentCard (Main Schema)
// =============================================================================

/**
 * Base agent card schema
 */
const baseAgentCardSchema = z.object({
  /** Schema version for Compose internal versioning */
  schemaVersion: z.literal("1.0.0"),

  /** Globally unique ID (e.g., "mcp://glama/notion") */
  id: z.string().min(1),

  /** Human-readable name */
  name: z.string().min(1),

  /** Description */
  description: z.string().optional(),

  /** Public base URL for this agent */
  url: z.string().min(1),

  /** Semantic version or commit hash */
  version: z.string().min(1),

  /** Icon URL */
  iconUrl: z.string().url().optional(),

  /** Author metadata */
  author: z
    .object({
      name: z.string().optional(),
      website: z.string().optional(),
      github: z.string().optional(),
      twitter: z.string().optional(),
    })
    .optional(),

  /** Capability hints for discovery */
  capabilities: z.array(z.string().min(1)).default([]),

  /** A2A-style supported interfaces */
  supportedInterfaces: z.array(supportedInterfaceSchema).min(1),

  /** A2A default input modes */
  defaultInputModes: z
    .array(z.string().min(1))
    .nonempty()
    .default(["application/json"]),

  /** A2A default output modes */
  defaultOutputModes: z
    .array(z.string().min(1))
    .nonempty()
    .default(["application/json", "text/plain"]),

  /** All callable capabilities */
  skills: z.array(agentSkillSchema).min(1),

  /** Optional flat entrypoints map (x4ai style) */
  entrypoints: z
    .record(
      z.string(),
      z.object({
        description: z.string().min(1),
        streaming: z.boolean().optional(),
        inputSchema: jsonSchemaZ,
        outputSchema: jsonSchemaZ.optional(),
        pricing: skillPricingSchema.optional(),
      })
    )
    .optional(),

  /** x402/AP2 payment methods (ThirdWeb compatible) */
  payments: z.array(paymentMethodSchema).default([]),

  /** ERC-8004 identity hook (ThirdWeb Deploy compatible) */
  onchain: onchainIdentitySchema.optional(),

  /** MCP binding for underlying server */
  mcp: mcpBindingSchema.optional(),

  /** Free-form extensions */
  extensions: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Full ComposeAgentCard schema with cross-field validation
 * 
 * Validates:
 * - skills[].pricing.paymentMethodId must exist in payments[].id
 * - entrypoints[].pricing.paymentMethodId must exist in payments[].id
 */
export const composeAgentCardSchema = baseAgentCardSchema.superRefine(
  (card, ctx) => {
    const paymentIds = new Set(card.payments.map((p) => p.id));

    // Validate skill payment references
    card.skills.forEach((skill, skillIndex) => {
      const pmId = skill.pricing?.paymentMethodId;
      if (pmId && !paymentIds.has(pmId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["skills", skillIndex, "pricing", "paymentMethodId"],
          message: `Unknown paymentMethodId "${pmId}". Must match one of payments[].id.`,
        });
      }
    });

    // Validate entrypoint payment references
    if (card.entrypoints) {
      for (const [name, ep] of Object.entries(card.entrypoints)) {
        const pmId = ep.pricing?.paymentMethodId;
        if (pmId && !paymentIds.has(pmId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["entrypoints", name, "pricing", "paymentMethodId"],
            message: `Unknown paymentMethodId "${pmId}" in entrypoint "${name}".`,
          });
        }
      }
    }
  }
);

// =============================================================================
// Type Exports
// =============================================================================

export type ComposeAgentCard = z.infer<typeof composeAgentCardSchema>;
export type ComposeAgentSkill = z.infer<typeof agentSkillSchema>;
export type ComposePaymentMethod = z.infer<typeof paymentMethodSchema>;
export type ComposeOnchainIdentity = z.infer<typeof onchainIdentitySchema>;
export type ComposeOnchainEndpoint = z.infer<typeof onchainEndpointSchema>;
export type ComposeSupportedInterface = z.infer<typeof supportedInterfaceSchema>;
export type ComposeMcpBinding = z.infer<typeof mcpBindingSchema>;
export type ComposeSkillPricing = z.infer<typeof skillPricingSchema>;
export type ComposeSkillAuth = z.infer<typeof skillAuthSchema>;

// =============================================================================
// Chain Configuration (Centralized for easy multi-chain support)
// =============================================================================

/**
 * Chain IDs - add new chains here to support them across the app
 * Only modify this file to add chain support - no code changes needed elsewhere
 */
export const CHAIN_IDS = {
  // Avalanche
  avalancheFuji: 43113,
  avalanche: 43114,
  // BNB Chain
  bscTestnet: 97,
  bsc: 56,
  // Arbitrum
  arbitrumSepolia: 421614,
  arbitrum: 42161,
  // Polygon
  polygonAmoy: 80002,
  polygon: 137,
  // Base
  baseSepolia: 84532,
  base: 8453,
  // Ethereum
  sepolia: 11155111,
  ethereum: 1,
} as const;

/** String versions for schema compatibility */
export const THIRDWEB_CHAIN_IDS = {
  avalancheFuji: "43113",
  avalanche: "43114",
  bscTestnet: "97",
  bsc: "56",
  arbitrumSepolia: "421614",
  arbitrum: "42161",
  polygonAmoy: "80002",
  polygon: "137",
  baseSepolia: "84532",
  base: "8453",
  sepolia: "11155111",
  ethereum: "1",
} as const;

/**
 * USDC addresses per chain
 * Add addresses here to support payments on new chains
 */
export const USDC_ADDRESSES: Record<number, `0x${string}`> = {
  // Avalanche
  [CHAIN_IDS.avalancheFuji]: "0x5425890298aed601595a70AB815c96711a31Bc65",
  [CHAIN_IDS.avalanche]: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
  // BNB Chain
  [CHAIN_IDS.bscTestnet]: "0x64544969ed7EBf5f083679233325356EbE738930",
  [CHAIN_IDS.bsc]: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
  // Arbitrum
  [CHAIN_IDS.arbitrumSepolia]: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
  [CHAIN_IDS.arbitrum]: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  // Polygon
  [CHAIN_IDS.polygonAmoy]: "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582",
  [CHAIN_IDS.polygon]: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  // Base
  [CHAIN_IDS.baseSepolia]: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  [CHAIN_IDS.base]: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  // Ethereum
  [CHAIN_IDS.sepolia]: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  [CHAIN_IDS.ethereum]: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
};

/** Chain metadata for UI and logic */
export const CHAIN_CONFIG: Record<number, {
  name: string;
  shortName: string;
  isTestnet: boolean;
  explorer: string;
  rpcEnvVar: string;
}> = {
  [CHAIN_IDS.avalancheFuji]: {
    name: "Avalanche Fuji",
    shortName: "Fuji",
    isTestnet: true,
    explorer: "https://testnet.avascan.info",
    rpcEnvVar: "AVALANCHE_FUJI_RPC",
  },
  [CHAIN_IDS.avalanche]: {
    name: "Avalanche C-Chain",
    shortName: "Avalanche",
    isTestnet: false,
    explorer: "https://avascan.info",
    rpcEnvVar: "AVALANCHE_MAINNET_RPC",
  },
  [CHAIN_IDS.bscTestnet]: {
    name: "BNB Smart Chain Testnet",
    shortName: "BSC Testnet",
    isTestnet: true,
    explorer: "https://testnet.bscscan.com",
    rpcEnvVar: "BSC_TESTNET_RPC",
  },
  [CHAIN_IDS.bsc]: {
    name: "BNB Smart Chain",
    shortName: "BSC",
    isTestnet: false,
    explorer: "https://bscscan.com",
    rpcEnvVar: "BSC_MAINNET_RPC",
  },
  [CHAIN_IDS.arbitrumSepolia]: {
    name: "Arbitrum Sepolia",
    shortName: "Arb Sepolia",
    isTestnet: true,
    explorer: "https://sepolia.arbiscan.io",
    rpcEnvVar: "ARBITRUM_SEPOLIA_RPC",
  },
  [CHAIN_IDS.arbitrum]: {
    name: "Arbitrum One",
    shortName: "Arbitrum",
    isTestnet: false,
    explorer: "https://arbiscan.io",
    rpcEnvVar: "ARBITRUM_MAINNET_RPC",
  },
  [CHAIN_IDS.polygonAmoy]: {
    name: "Polygon Amoy",
    shortName: "Amoy",
    isTestnet: true,
    explorer: "https://amoy.polygonscan.com",
    rpcEnvVar: "POLYGON_AMOY_RPC",
  },
  [CHAIN_IDS.polygon]: {
    name: "Polygon",
    shortName: "Polygon",
    isTestnet: false,
    explorer: "https://polygonscan.com",
    rpcEnvVar: "POLYGON_MAINNET_RPC",
  },
  [CHAIN_IDS.baseSepolia]: {
    name: "Base Sepolia",
    shortName: "Base Sepolia",
    isTestnet: true,
    explorer: "https://sepolia.basescan.org",
    rpcEnvVar: "BASE_SEPOLIA_RPC",
  },
  [CHAIN_IDS.base]: {
    name: "Base",
    shortName: "Base",
    isTestnet: false,
    explorer: "https://basescan.org",
    rpcEnvVar: "BASE_MAINNET_RPC",
  },
  [CHAIN_IDS.sepolia]: {
    name: "Sepolia",
    shortName: "Sepolia",
    isTestnet: true,
    explorer: "https://sepolia.etherscan.io",
    rpcEnvVar: "SEPOLIA_RPC",
  },
  [CHAIN_IDS.ethereum]: {
    name: "Ethereum",
    shortName: "Ethereum",
    isTestnet: false,
    explorer: "https://etherscan.io",
    rpcEnvVar: "ETHEREUM_MAINNET_RPC",
  },
};

/**
 * Get the active chain ID based on environment
 * Uses VITE_USE_MAINNET for frontend, USE_MAINNET for backend
 */
export function getActiveChainId(): number {
  const useMainnet = 
    typeof process !== "undefined" 
      ? process.env.USE_MAINNET === "true" 
      : false;
  return useMainnet ? CHAIN_IDS.avalanche : CHAIN_IDS.avalancheFuji;
}

/**
 * Get USDC address for a chain
 */
export function getUsdcAddress(chainId: number): `0x${string}` | undefined {
  return USDC_ADDRESSES[chainId];
}

/**
 * Get chain config by ID
 */
export function getChainConfigById(chainId: number) {
  return CHAIN_CONFIG[chainId];
}

/** Default payment config for Compose Market (Avalanche Fuji testnet) */
export const DEFAULT_PAYMENT_CONFIG = {
  network: THIRDWEB_CHAIN_IDS.avalancheFuji,
  assetSymbol: "USDC",
  assetAddress: USDC_ADDRESSES[CHAIN_IDS.avalancheFuji],
  scheme: "upto" as const,
};

/** Pricing configuration for AI inference */
export const PRICING_CONFIG = {
  pricePerTokenWei: 1, // 0.000001 USDC per token
  maxTokensPerCall: 100000, // 100k tokens max
};

