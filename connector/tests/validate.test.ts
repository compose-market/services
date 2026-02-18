import { describe, expect, it } from "vitest";
import {
  assertValidAgentCard,
  formatValidationErrors,
  getX402PaymentMethods,
  hasOnchainIdentity,
  hasValidX402Config,
  validateAgentCard,
  validatePartialCard,
} from "../src/validate.js";

const validCard = {
  schemaVersion: "1.0.0",
  id: "mcp://mcp/notion",
  name: "Notion Agent",
  description: "Search and summarize Notion content",
  url: "https://compose.market/agents/notion",
  version: "1.0.0",
  capabilities: ["search", "summarize"],
  supportedInterfaces: [
    {
      protocolBinding: "HTTP+JSON",
      url: "https://compose.market/agents/notion",
      version: "1.0.0",
    },
  ],
  defaultInputModes: ["application/json"],
  defaultOutputModes: ["application/json"],
  skills: [
    {
      id: "mcp://notion/search",
      name: "Search Notion",
      description: "Searches Notion pages",
      tags: ["search"],
      inputModes: ["application/json"],
      outputModes: ["application/json"],
      streaming: false,
      inputSchema: {
        query: { type: "string" },
      },
    },
  ],
  payments: [
    {
      id: "payment-usdc-fuji",
      method: "x402",
      network: "43113",
      assetSymbol: "USDC",
      assetAddress: "0x5425890298aed601595a70AB815c96711a31Bc65",
      payee: "0x1111111111111111111111111111111111111111",
      x402: {
        scheme: "exact",
      },
    },
  ],
};

describe("connector validate helpers", () => {
  it("validates a complete ComposeAgentCard", () => {
    const result = validateAgentCard(validCard);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.card.id).toBe(validCard.id);
      expect(result.card.skills).toHaveLength(1);
    }
  });

  it("throws detailed assertion error for invalid card", () => {
    expect(() => assertValidAgentCard({})).toThrow("Invalid ComposeAgentCard");

    try {
      assertValidAgentCard({});
    } catch (error) {
      const err = error as Error & { details?: Array<{ path: string; message: string }> };
      expect(err.details?.length).toBeGreaterThan(0);
      expect(err.details?.some((d) => d.path.includes("schemaVersion"))).toBe(true);
    }
  });

  it("supports partial validation for iterative card construction", () => {
    const errors = validatePartialCard(
      {
        id: "x",
        payments: [{ method: "x402" }],
      },
      ["id", "payments"],
    );

    expect(errors.length).toBeGreaterThan(0);
  });

  it("detects valid x402 payment config", () => {
    expect(hasValidX402Config(validCard as any)).toBe(true);
    expect(getX402PaymentMethods(validCard as any)).toHaveLength(1);
  });

  it("detects missing on-chain identity and formats errors", () => {
    expect(hasOnchainIdentity(validCard as any)).toBe(false);

    const formatted = formatValidationErrors([
      { path: "skills[0].id", message: "required" },
      { path: "payments[0].payee", message: "invalid address" },
    ]);

    expect(formatted).toContain("1. skills[0].id: required");
    expect(formatted).toContain("2. payments[0].payee: invalid address");
  });
});
