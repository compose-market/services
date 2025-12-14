import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export type ConnectorId = "x" | "notion" | "google-workspace" | "discord";

export interface ConnectorConfig {
  id: ConnectorId;
  label: string;
  description: string;
  command: string;
  args: string[];
  requiredEnv: string[];
  /** Whether to use HTTP-based connector instead of MCP stdio */
  httpBased?: boolean;
}

export interface ConnectorInfo {
  id: ConnectorId;
  label: string;
  description: string;
  available: boolean;
  missingEnv?: string[];
}

export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface CallToolResult {
  content: unknown;
  raw: unknown;
  isError?: boolean;
}

export interface ConnectorClient {
  listTools(): Promise<Tool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

