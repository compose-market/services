/**
 * Internal Tools Registry
 * 
 * Defines Compose Market's core internal integrations as MCP-like server entries
 * that appear in the same registry alongside external Mcp servers.
 * 
 * Note: GOAT and ElizaOS plugins are loaded from JSON files synced by scripts/sync-plugins.ts
 */

/** Supported namespaces for internal servers */
export type ServerNamespace = "compose-market";

/** Internal MCP-like server entry */
export interface InternalMcpServer {
  /** Unique ID in the registry */
  id: string;
  /** Human-readable name */
  name: string;
  /** Namespace for the server */
  namespace: ServerNamespace;
  /** URL-safe slug */
  slug: string;
  /** What this integration does */
  description: string;
  /** Marker that this is internal */
  kind: "internal";
  /** Capability attributes */
  attributes: string[];
  /** How to access this integration */
  entryPoint: {
    /** Entry point type */
    type: "connector" | "http" | "lambda";
    /** Connector ID for existing connectors */
    connectorId?: string;
    /** HTTP endpoint for remote services */
    endpoint?: string;
  };
  /** Tool definitions (similar to MCP tools) */
  tools: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }>;
  /** Required environment variables */
  requiredEnv?: string[];
  /** Category for filtering */
  category: string;
  /** Tags for search */
  tags: string[];
}

/**
 * Compose Market's internal integrations
 */
export const INTERNAL_SERVERS: InternalMcpServer[] = [
  {
    id: "compose-http-connector",
    name: "HTTP Connector",
    namespace: "compose-market",
    slug: "http-connector",
    description:
      "Generic HTTP tool for calling arbitrary web APIs with method, URL, headers and body. Supports REST, GraphQL, and any HTTP-based service.",
    kind: "internal",
    attributes: ["hosting:remote-capable", "category:network"],
    entryPoint: {
      type: "http",
    },
    tools: [
      {
        name: "http_request",
        description: "Make an HTTP request to any URL",
        inputSchema: {
          type: "object",
          properties: {
            method: {
              type: "string",
              enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
              description: "HTTP method",
            },
            url: {
              type: "string",
              description: "Target URL",
            },
            headers: {
              type: "object",
              description: "HTTP headers",
              additionalProperties: { type: "string" },
            },
            body: {
              type: "string",
              description: "Request body (for POST/PUT/PATCH)",
            },
          },
          required: ["method", "url"],
        },
      },
    ],
    category: "network",
    tags: ["http", "rest", "api", "web"],
  },
  {
    id: "compose-pinata-ipfs",
    name: "Pinata IPFS",
    namespace: "compose-market",
    slug: "pinata-ipfs",
    description:
      "Upload and pin files to IPFS via Pinata. Used for NFT metadata, off-chain storage, and decentralized file hosting.",
    kind: "internal",
    attributes: ["hosting:remote-capable", "category:storage", "category:ipfs"],
    entryPoint: {
      type: "lambda",
      endpoint: "/api/pinata",
    },
    tools: [
      {
        name: "pin_json",
        description: "Pin JSON data to IPFS",
        inputSchema: {
          type: "object",
          properties: {
            data: {
              type: "object",
              description: "JSON data to pin",
            },
            name: {
              type: "string",
              description: "Name for the pinned file",
            },
          },
          required: ["data"],
        },
      },
      {
        name: "pin_file",
        description: "Pin a file to IPFS",
        inputSchema: {
          type: "object",
          properties: {
            base64: {
              type: "string",
              description: "Base64-encoded file content",
            },
            filename: {
              type: "string",
              description: "Filename",
            },
            mimeType: {
              type: "string",
              description: "MIME type of the file",
            },
          },
          required: ["base64", "filename"],
        },
      },
      {
        name: "get_by_cid",
        description: "Retrieve content by IPFS CID",
        inputSchema: {
          type: "object",
          properties: {
            cid: {
              type: "string",
              description: "IPFS Content Identifier",
            },
          },
          required: ["cid"],
        },
      },
    ],
    requiredEnv: ["PINATA_JWT", "IPFS_PINATA_GATEWAY"],
    category: "storage",
    tags: ["ipfs", "pinata", "storage", "nft", "decentralized"],
  },
  {
    id: "compose-x-twitter",
    name: "X (Twitter)",
    namespace: "compose-market",
    slug: "x-twitter",
    description:
      "Post tweets, read timelines, search, and manage X/Twitter account via the X API v2.",
    kind: "internal",
    attributes: ["hosting:remote-capable", "category:social"],
    entryPoint: {
      type: "connector",
      connectorId: "x",
    },
    tools: [
      {
        name: "post_tweet",
        description: "Post a new tweet",
        inputSchema: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "Tweet content (max 280 characters)",
            },
          },
          required: ["text"],
        },
      },
      {
        name: "get_user_timeline",
        description: "Get recent tweets from a user's timeline",
        inputSchema: {
          type: "object",
          properties: {
            username: {
              type: "string",
              description: "Twitter username (without @)",
            },
            max_results: {
              type: "number",
              description: "Maximum tweets to return (5-100)",
              default: 10,
            },
          },
          required: ["username"],
        },
      },
      {
        name: "search_tweets",
        description: "Search for tweets matching a query",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query",
            },
            max_results: {
              type: "number",
              description: "Maximum tweets to return (10-100)",
              default: 10,
            },
          },
          required: ["query"],
        },
      },
      {
        name: "get_user_info",
        description: "Get information about a Twitter user",
        inputSchema: {
          type: "object",
          properties: {
            username: {
              type: "string",
              description: "Twitter username (without @)",
            },
          },
          required: ["username"],
        },
      },
    ],
    requiredEnv: [
      "X_API_KEY",
      "X_API_KEY_SECRET",
      "X_ACCESS_TOKEN",
      "X_ACCESS_TOKEN_SECRET",
      "X_BEARER_TOKEN",
    ],
    category: "social",
    tags: ["twitter", "x", "social", "posts", "timeline"],
  },
  {
    id: "compose-notion",
    name: "Notion",
    namespace: "compose-market",
    slug: "notion",
    description:
      "Read and write Notion pages, databases, and blocks. Manage your Notion workspace programmatically.",
    kind: "internal",
    attributes: ["hosting:remote-capable", "category:productivity"],
    entryPoint: {
      type: "connector",
      connectorId: "notion",
    },
    tools: [
      {
        name: "search",
        description: "Search pages and databases in Notion",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query",
            },
            filter: {
              type: "object",
              description: "Optional filter for results",
            },
          },
        },
      },
      {
        name: "get_page",
        description: "Get a Notion page by ID",
        inputSchema: {
          type: "object",
          properties: {
            page_id: {
              type: "string",
              description: "Notion page ID",
            },
          },
          required: ["page_id"],
        },
      },
      {
        name: "create_page",
        description: "Create a new Notion page",
        inputSchema: {
          type: "object",
          properties: {
            parent_id: {
              type: "string",
              description: "Parent page or database ID",
            },
            title: {
              type: "string",
              description: "Page title",
            },
            content: {
              type: "array",
              description: "Page content blocks",
            },
          },
          required: ["parent_id", "title"],
        },
      },
    ],
    requiredEnv: ["NOTION_API_KEY"],
    category: "productivity",
    tags: ["notion", "docs", "database", "wiki", "productivity"],
  },
  {
    id: "compose-ai-inference",
    name: "AI Inference",
    namespace: "compose-market",
    slug: "ai-inference",
    description:
      "Access multiple AI models (OpenAI, Anthropic, Google, ASI) through a unified interface with x402 micropayments.",
    kind: "internal",
    attributes: ["hosting:remote-capable", "category:ai", "x402:enabled"],
    entryPoint: {
      type: "lambda",
      endpoint: "/api/inference",
    },
    tools: [
      {
        name: "chat_completion",
        description: "Generate a chat completion from an AI model",
        inputSchema: {
          type: "object",
          properties: {
            messages: {
              type: "array",
              description: "Chat messages",
              items: {
                type: "object",
                properties: {
                  role: { type: "string", enum: ["user", "assistant", "system"] },
                  content: { type: "string" },
                },
                required: ["role", "content"],
              },
            },
            modelId: {
              type: "string",
              description: "Model ID (e.g., gpt-4o, claude-sonnet, gemini-pro)",
            },
            systemPrompt: {
              type: "string",
              description: "System prompt",
            },
          },
          required: ["messages"],
        },
      },
    ],
    requiredEnv: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
    category: "ai",
    tags: ["ai", "llm", "inference", "openai", "anthropic", "google", "x402"],
  },
  {
    id: "compose-google-workspace",
    name: "Google Workspace",
    namespace: "compose-market",
    slug: "google-workspace",
    description:
      "Access Gmail, Calendar, Drive, Docs, Sheets, and more Google Workspace services.",
    kind: "internal",
    attributes: ["hosting:remote-capable", "category:productivity"],
    entryPoint: {
      type: "connector",
      connectorId: "google-workspace",
    },
    tools: [
      {
        name: "gmail_search",
        description: "Search Gmail messages",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Gmail search query",
            },
            maxResults: {
              type: "number",
              description: "Maximum results to return",
              default: 10,
            },
          },
          required: ["query"],
        },
      },
      {
        name: "calendar_list_events",
        description: "List calendar events",
        inputSchema: {
          type: "object",
          properties: {
            calendarId: {
              type: "string",
              description: "Calendar ID (default: primary)",
              default: "primary",
            },
            timeMin: {
              type: "string",
              description: "Start time (ISO format)",
            },
            timeMax: {
              type: "string",
              description: "End time (ISO format)",
            },
          },
        },
      },
      {
        name: "drive_search",
        description: "Search Google Drive files",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Drive search query",
            },
          },
          required: ["query"],
        },
      },
    ],
    requiredEnv: ["GOOGLE_CREDENTIALS_JSON", "GOOGLE_SUBJECT_EMAIL"],
    category: "productivity",
    tags: ["google", "gmail", "calendar", "drive", "docs", "sheets", "workspace"],
  },
  {
    id: "compose-discord",
    name: "Discord",
    namespace: "compose-market",
    slug: "discord",
    description:
      "Read and write to Discord channels, manage servers, and interact with Discord communities.",
    kind: "internal",
    attributes: ["hosting:remote-capable", "category:communication"],
    entryPoint: {
      type: "connector",
      connectorId: "discord",
    },
    tools: [
      {
        name: "send_message",
        description: "Send a message to a Discord channel",
        inputSchema: {
          type: "object",
          properties: {
            channelId: {
              type: "string",
              description: "Discord channel ID",
            },
            content: {
              type: "string",
              description: "Message content",
            },
          },
          required: ["channelId", "content"],
        },
      },
      {
        name: "get_messages",
        description: "Get messages from a Discord channel",
        inputSchema: {
          type: "object",
          properties: {
            channelId: {
              type: "string",
              description: "Discord channel ID",
            },
            limit: {
              type: "number",
              description: "Number of messages to fetch",
              default: 50,
            },
          },
          required: ["channelId"],
        },
      },
    ],
    requiredEnv: ["DISCORD_BOT_TOKEN"],
    category: "communication",
    tags: ["discord", "chat", "community", "messaging"],
  },
  // Note: GOAT and ElizaOS plugins are loaded from JSON files by registry.ts
  // See: data/goatPlugins.json and data/elizaPlugins.json
];

/**
 * Get all internal servers (Compose Market's core tools)
 */
export function getInternalServers(): InternalMcpServer[] {
  return INTERNAL_SERVERS;
}

/**
 * Get an internal server by ID
 */
export function getInternalServerById(id: string): InternalMcpServer | undefined {
  return INTERNAL_SERVERS.find((s) => s.id === id);
}

/**
 * Get internal servers by category
 */
export function getInternalServersByCategory(category: string): InternalMcpServer[] {
  return INTERNAL_SERVERS.filter((s) => s.category === category);
}

/**
 * Check if an internal server has all required env vars
 */
export function isInternalServerAvailable(server: InternalMcpServer): boolean {
  if (!server.requiredEnv || server.requiredEnv.length === 0) {
    return true;
  }
  return server.requiredEnv.every((env) => process.env[env]);
}

/**
 * Get missing env vars for an internal server
 */
export function getMissingEnvForServer(server: InternalMcpServer): string[] {
  if (!server.requiredEnv) {
    return [];
  }
  return server.requiredEnv.filter((env) => !process.env[env]);
}

