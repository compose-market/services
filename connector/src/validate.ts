/**
 * AgentCard Validation Helpers
 * 
 * Validation functions for ComposeAgentCard schema.
 */
import { z } from "zod";
import {
  composeAgentCardSchema,
  type ComposeAgentCard,
} from "./schema.js";

/** Validation error with path information */
export interface ValidationError {
  path: string;
  message: string;
}

/** Validation result type */
export type ValidationResult =
  | { ok: true; card: ComposeAgentCard }
  | { ok: false; errors: ValidationError[] };

/**
 * Validate an unknown input into a ComposeAgentCard
 * 
 * Returns either { ok: true, card } or { ok: false, errors[] }
 */
export function validateAgentCard(input: unknown): ValidationResult {
  const result = composeAgentCardSchema.safeParse(input);

  if (result.success) {
    return {
      ok: true,
      card: result.data,
    };
  }

  const errors: ValidationError[] = result.error.issues.map((issue) => {
    const path =
      issue.path && issue.path.length
        ? issue.path
            .map((segment) =>
              typeof segment === "number" ? `[${segment}]` : segment
            )
            .join(".")
        : "(root)";

    return {
      path,
      message: issue.message,
    };
  });

  return { ok: false, errors };
}

/**
 * Assert-style validator: throws on invalid card
 * 
 * @throws Error with details if validation fails
 */
export function assertValidAgentCard(input: unknown): ComposeAgentCard {
  const result = validateAgentCard(input);
  
  if (!result.ok) {
    const msg =
      "Invalid ComposeAgentCard:\n" +
      result.errors
        .map((e) => `  - ${e.path}: ${e.message}`)
        .join("\n");
    const error = new Error(msg) as Error & { details: ValidationError[] };
    error.details = result.errors;
    throw error;
  }
  
  return result.card;
}

/**
 * Partial validation for incremental card building
 * 
 * Validates specific fields without requiring a complete card.
 */
export function validatePartialCard(
  input: Record<string, unknown>,
  _fields: (keyof ComposeAgentCard)[]
): ValidationError[] {
  // For partial validation, just validate the whole input as a partial card
  const result = composeAgentCardSchema.partial().safeParse(input);
  
  if (result.success) {
    return [];
  }
  
  return result.error.issues.map((issue) => {
    const path =
      issue.path && issue.path.length
        ? issue.path
            .map((segment) =>
              typeof segment === "number" ? `[${segment}]` : String(segment)
            )
            .join(".")
        : "(root)";
    return { path, message: issue.message };
  });
}

// Note: validateSkill and validatePaymentMethod removed - use validateAgentCard for full validation

/**
 * Format validation errors for display
 */
export function formatValidationErrors(errors: ValidationError[]): string {
  if (errors.length === 0) {
    return "No errors";
  }
  
  return errors
    .map((e, i) => `${i + 1}. ${e.path}: ${e.message}`)
    .join("\n");
}

/**
 * Check if a card has valid x402 payment configuration
 */
export function hasValidX402Config(card: ComposeAgentCard): boolean {
  const x402Methods = card.payments.filter((p) => p.method === "x402");
  
  if (x402Methods.length === 0) {
    return false;
  }
  
  // Check that at least one x402 method has valid config
  return x402Methods.some((p) => {
    return (
      p.network &&
      p.assetAddress &&
      p.payee &&
      /^0x[a-fA-F0-9]{40}$/.test(p.assetAddress) &&
      /^0x[a-fA-F0-9]{40}$/.test(p.payee)
    );
  });
}

/**
 * Get x402 payment methods from a card
 */
export function getX402PaymentMethods(card: ComposeAgentCard) {
  return card.payments.filter((p) => p.method === "x402");
}

/**
 * Check if card has on-chain identity configured
 */
export function hasOnchainIdentity(card: ComposeAgentCard): boolean {
  return !!(
    card.onchain &&
    card.onchain.registryChainId &&
    card.onchain.registryAddress &&
    card.onchain.agentId
  );
}

