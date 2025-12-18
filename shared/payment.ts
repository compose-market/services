/**
 * x402 Payment Module (Shared)
 *
 * ThirdWeb-native x402 payment verification and settlement.
 * Uses Thirdweb's facilitator + settlePayment for on-chain payment.
 *
 * Shared across connector and sandbox services.
 */
import { createThirdwebClient } from "thirdweb";
import { facilitator, settlePayment } from "thirdweb/x402";
import { avalancheFuji, avalanche } from "thirdweb/chains";
import {
    USE_MAINNET,
    THIRDWEB_SECRET_KEY,
    SERVER_WALLET_ADDRESS,
    MERCHANT_WALLET_ADDRESS,
} from "./config.js";

// =============================================================================
// Configuration
// =============================================================================

// Chain configuration
const paymentChain = USE_MAINNET ? avalanche : avalancheFuji;

// USDC addresses
const USDC_ADDRESSES: Record<number, `0x${string}`> = {
    43113: "0x5425890298aed601595a70AB815c96711a31Bc65", // Fuji
    43114: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", // Mainnet
};

const usdcAddress = USDC_ADDRESSES[paymentChain.id];

// Validate configuration
if (!THIRDWEB_SECRET_KEY) {
    console.warn("⚠️ THIRDWEB_SECRET_KEY not set - x402 payments will fail");
}
if (!SERVER_WALLET_ADDRESS) {
    console.warn(
        "⚠️ THIRDWEB_SERVER_WALLET_ADDRESS not set - x402 payments will fail"
    );
}

// Server-side client with secret key
const serverClient = THIRDWEB_SECRET_KEY
    ? createThirdwebClient({ secretKey: THIRDWEB_SECRET_KEY })
    : null;

// x402 Facilitator
const thirdwebFacilitator =
    serverClient && SERVER_WALLET_ADDRESS
        ? facilitator({
            client: serverClient,
            serverWalletAddress: SERVER_WALLET_ADDRESS,
        })
        : null;

// =============================================================================
// Default Pricing (in USDC wei - 6 decimals)
// =============================================================================

export const DEFAULT_PRICES = {
    MCP_TOOL_CALL: "1000",        // $0.001
    GOAT_EXECUTE: "1000",         // $0.001
    ELIZA_MESSAGE: "1000",        // $0.001
    ELIZA_ACTION: "2000",         // $0.002
    WORKFLOW_RUN: "10000",        // $0.01
    AGENT_CHAT: "5000",           // $0.005
} as const;

// =============================================================================
// Payment Handler
// =============================================================================

export interface X402Result {
    status: number;
    responseBody: unknown;
    responseHeaders: Record<string, string>;
}

/**
 * Handle x402 payment verification and settlement
 *
 * @param paymentData - The x-payment header value from client
 * @param resourceUrl - Full URL of the resource being accessed
 * @param method - HTTP method (GET, POST, etc.)
 * @param amountWei - Amount to charge in USDC wei (6 decimals)
 */
export async function handleX402Payment(
    paymentData: string | null | undefined,
    resourceUrl: string,
    method: string,
    amountWei: string = DEFAULT_PRICES.MCP_TOOL_CALL
): Promise<X402Result> {
    // Check configuration
    if (!thirdwebFacilitator || !serverClient) {
        console.error(
            "[x402] Facilitator not configured - missing THIRDWEB_SECRET_KEY or THIRDWEB_SERVER_WALLET_ADDRESS"
        );
        return {
            status: 500,
            responseBody: { error: "Payment system not configured" },
            responseHeaders: {},
        };
    }

    console.log(`[x402] settlePayment for ${resourceUrl}`);
    console.log(`[x402] paymentData present: ${!!paymentData}`);
    console.log(
        `[x402] amount: ${amountWei} wei ($${(parseInt(amountWei) / 1_000_000).toFixed(6)})`
    );
    console.log(`[x402] payTo: ${MERCHANT_WALLET_ADDRESS}`);

    const result = await settlePayment({
        resourceUrl,
        method,
        paymentData: paymentData || null,
        payTo: MERCHANT_WALLET_ADDRESS!,
        network: paymentChain,
        price: {
            amount: amountWei,
            asset: {
                address: usdcAddress,
            },
        },
        facilitator: thirdwebFacilitator,
    });

    console.log(`[x402] result status: ${result.status}`);

    // SettlePaymentResult is a union type:
    // - status 200: { paymentReceipt: {...} }
    // - status 402/500/etc: { responseBody: {...} }
    return {
        status: result.status,
        responseBody:
            result.status === 200
                ? {
                    success: true,
                    receipt: (result as { paymentReceipt: unknown }).paymentReceipt,
                }
                : (result as { responseBody: unknown }).responseBody,
        responseHeaders: result.responseHeaders as Record<string, string>,
    };
}

/**
 * Check if request has valid active session (client-side budget management)
 * This is a fallback for session-based payment when x402 header is not provided
 */
export function hasActiveSession(
    headers: Record<string, string | undefined>
): boolean {
    const sessionActive = headers["x-session-active"] === "true";
    const budgetRemaining = parseInt(
        headers["x-session-budget-remaining"] || "0",
        10
    );
    return sessionActive && budgetRemaining > 0;
}

/**
 * Extract payment info from request headers
 */
export function extractPaymentInfo(
    headers: Record<string, string | string[] | undefined>
): {
    paymentData: string | null;
    sessionActive: boolean;
    sessionBudgetRemaining: number;
} {
    const paymentData =
        typeof headers["x-payment"] === "string" ? headers["x-payment"] : null;
    const sessionActive = headers["x-session-active"] === "true";
    const sessionBudgetRemaining = parseInt(
        typeof headers["x-session-budget-remaining"] === "string"
            ? headers["x-session-budget-remaining"]
            : "0",
        10
    );

    return {
        paymentData,
        sessionActive,
        sessionBudgetRemaining,
    };
}

/**
 * Build parameters for 402 Payment Required response
 */
export function buildPaymentRequiredHeaders(
    details: {
        method: string;
        id: string;
        network: string;
        assetAddress: string;
        assetSymbol: string;
        payee: string;
        x402: { scheme: string };
    },
    args: { pricing: { amount: string } }
): Record<string, string> {
    return {
        "x-payment-required": "true",
        "x-payment-method": details.method,
        "x-payment-id": details.id,
        "x-payment-network": details.network,
        "x-payment-asset-address": details.assetAddress,
        "x-payment-asset-symbol": details.assetSymbol,
        "x-payment-payee": details.payee,
        "x-payment-scheme": details.x402.scheme,
        "x-payment-price-amount": args.pricing.amount,
    };
}

// Export configuration for reference
export {
    paymentChain,
    usdcAddress,
    SERVER_WALLET_ADDRESS,
    MERCHANT_WALLET_ADDRESS,
};
