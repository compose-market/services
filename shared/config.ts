/**
 * Shared Configuration for Services
 *
 * Central configuration for all services (connector, sandbox, exporter).
 * Loads from the root .env file.
 */
import "dotenv/config";

// =============================================================================
// Service Ports
// =============================================================================

export const PORTS = {
    CONNECTOR: parseInt(process.env.CONNECTOR_PORT || "4001", 10),
    SANDBOX: parseInt(process.env.SANDBOX_PORT || "4002", 10),
    EXPORTER: parseInt(process.env.EXPORTER_PORT || "4003", 10),
} as const;

// =============================================================================
// Service URLs
// =============================================================================

/** URL of the Connector Hub service (internal) */
export const CONNECTOR_BASE_URL =
    process.env.CONNECTOR_BASE_URL || `http://localhost:${PORTS.CONNECTOR}`;

/** URL of the MCP service */
export const MCP_SERVICE_URL =
    process.env.MCP_SERVICE_URL || "https://mcp.compose.market";

/** Base URL for all services (external) */
export const SERVICES_URL =
    process.env.SERVICES_SERVICE_URL || "https://services.compose.market";

// =============================================================================
// Timeouts & Limits
// =============================================================================

/** Timeout for connector calls in milliseconds */
export const CONNECTOR_TIMEOUT_MS = parseInt(
    process.env.CONNECTOR_TIMEOUT_MS || "60000",
    10
);

/** Maximum workflow steps allowed */
export const MAX_WORKFLOW_STEPS = parseInt(
    process.env.MAX_WORKFLOW_STEPS || "50",
    10
);

// =============================================================================
// Chain Configuration
// =============================================================================

export const USE_MAINNET = process.env.USE_MAINNET === "true";

// =============================================================================
// Thirdweb Configuration
// =============================================================================

export const THIRDWEB_SECRET_KEY = process.env.THIRDWEB_SECRET_KEY;
export const SERVER_WALLET_ADDRESS = process.env
    .THIRDWEB_SERVER_WALLET_ADDRESS as `0x${string}` | undefined;
export const MERCHANT_WALLET_ADDRESS = (process.env.MERCHANT_WALLET_ADDRESS ||
    SERVER_WALLET_ADDRESS) as `0x${string}` | undefined;

// =============================================================================
// Validation & Logging
// =============================================================================

console.log("[config] Services Configuration:");
console.log(`  CONNECTOR_PORT: ${PORTS.CONNECTOR}`);
console.log(`  SANDBOX_PORT: ${PORTS.SANDBOX}`);
console.log(`  EXPORTER_PORT: ${PORTS.EXPORTER}`);
console.log(`  CONNECTOR_BASE_URL: ${CONNECTOR_BASE_URL}`);
console.log(`  MCP_SERVICE_URL: ${MCP_SERVICE_URL}`);
console.log(`  USE_MAINNET: ${USE_MAINNET}`);
