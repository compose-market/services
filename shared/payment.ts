/**
 * x402 Payment Module (Shared)
 *
 * Multi-chain x402 payment verification and settlement.
 * Supports:
 * - Cronos chains (338, 25) via Cronos Labs EIP-712 facilitator (@crypto.com/facilitator-client)
 * - ThirdWeb chains (Avalanche, etc.) via ThirdWeb SDK facilitator
 *
 * Chain is determined by X-CHAIN-ID header from client.
 * Shared across connector and sandbox services.
 */
import { createThirdwebClient } from "thirdweb";
import { facilitator, settlePayment } from "thirdweb/x402";
import {
    avalancheFuji, avalanche, cronos,
    type Chain,
} from "thirdweb/chains";
import { defineChain } from "thirdweb";
import { Facilitator, CronosNetwork, Scheme, Contract, type PaymentRequirements } from "@crypto.com/facilitator-client";
import {
    THIRDWEB_SECRET_KEY,
    SERVER_WALLET_ADDRESS,
    MERCHANT_WALLET_ADDRESS,
} from "./config.js";

// =============================================================================
// Chain Configuration
// =============================================================================

const CHAIN_IDS = {
    cronosTestnet: 338,
    cronos: 25,
    avalancheFuji: 43113,
    avalanche: 43114,
} as const;

type ChainId = (typeof CHAIN_IDS)[keyof typeof CHAIN_IDS];

/**
 * USDC addresses per chain
 */
const USDC_ADDRESSES: Record<number, `0x${string}`> = {
    // Cronos
    338: "0xc01efAaF7C5C61bEbFAeb358E1161b537b8bC0e0", // devUSDC.e
    25: "0xf951eC28187D9E5Ca673Da8FE6757E6f0Be5F77C", // USDC.e mainnet
    // Avalanche
    43113: "0x5425890298aed601595a70AB815c96711a31Bc65",
    43114: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
};

/**
 * Check if chain uses Cronos facilitator
 */
function isCronosChain(chainId: number): boolean {
    return chainId === CHAIN_IDS.cronosTestnet || chainId === CHAIN_IDS.cronos;
}

/**
 * Get USDC address for chain
 */
function getUsdcAddress(chainId: number): `0x${string}` {
    return USDC_ADDRESSES[chainId] || USDC_ADDRESSES[CHAIN_IDS.cronosTestnet];
}

/**
 * Cronos Testnet chain object (not pre-exported from thirdweb/chains)
 */
const cronosTestnet = defineChain({
    id: 338,
    name: "Cronos Testnet",
    nativeCurrency: { name: "Test CRO", symbol: "tCRO", decimals: 18 },
    rpc: process.env.CRONOS_TESTNET_RPC || "https://evm-t3.cronos.org",
    blockExplorers: [{ name: "Cronos Explorer", url: "https://explorer.cronos.org/testnet" }],
});

/**
 * Get ThirdWeb chain object by ID
 */
function getChainObject(chainId: number): Chain {
    switch (chainId) {
        case 338: return cronosTestnet;
        case 25: return cronos;
        case 43113: return avalancheFuji;
        case 43114: return avalanche;
        default: return cronosTestnet; // Default
    }
}

// =============================================================================
// Cronos Facilitator Setup
// =============================================================================

/**
 * Get Cronos SDK network enum by chain ID
 */
function getCronosNetwork(chainId: number): CronosNetwork {
    return chainId === CHAIN_IDS.cronos
        ? CronosNetwork.CronosMainnet
        : CronosNetwork.CronosTestnet;
}

/**
 * Get Cronos SDK contract enum by chain ID
 */
function getCronosContract(chainId: number): Contract {
    return chainId === CHAIN_IDS.cronos
        ? Contract.USDCe
        : Contract.DevUSDCe;
}

// Cached facilitator instances
const facilitatorCache: Map<number, Facilitator> = new Map();

/**
 * Get or create a Cronos facilitator client (cached)
 */
function getCronosFacilitator(chainId: number): Facilitator {
    if (!facilitatorCache.has(chainId)) {
        const network = getCronosNetwork(chainId);
        facilitatorCache.set(chainId, new Facilitator({ network }));
    }
    return facilitatorCache.get(chainId)!;
}

/**
 * Generate Cronos x402 payment requirements
 */
function generateCronosPaymentRequirements(params: {
    payTo: `0x${string}`;
    amount: string;
    chainId: number;
}): PaymentRequirements {
    const network = getCronosNetwork(params.chainId);
    const asset = getCronosContract(params.chainId);

    return {
        scheme: Scheme.Exact,
        network,
        payTo: params.payTo,
        asset,
        maxAmountRequired: params.amount,
        maxTimeoutSeconds: 300,
        description: "Compose.Market Service Execution",
        mimeType: "application/json",
    };
}

/**
 * Create Cronos x402 V1 402 response
 */
function createCronos402Response(params: {
    payTo: `0x${string}`;
    amount: string;
    chainId: number;
    description: string;
    resource: string;
}): object {
    const network = getCronosNetwork(params.chainId);
    const asset = getCronosContract(params.chainId);

    return {
        x402Version: 1,
        error: "payment_required",
        accepts: [{
            scheme: Scheme.Exact,
            network,
            payTo: params.payTo,
            asset,
            maxAmountRequired: params.amount,
            maxTimeoutSeconds: 300,
            description: params.description,
            mimeType: "application/json",
            resource: params.resource,
        }],
    };
}

/**
 * Verify and settle payment via Cronos facilitator
 */
async function verifyAndSettleCronosPayment(params: {
    paymentHeader: string;
    payTo: `0x${string}`;
    amount: string;
    chainId: number;
}): Promise<{ status: number; success: boolean; txHash?: string; blockNumber?: number; error?: string }> {
    const { paymentHeader, payTo, amount, chainId } = params;

    console.log(`[cronos-x402] Settling payment on chain ${chainId}`);

    try {
        const facilitator = getCronosFacilitator(chainId);
        const requirements = generateCronosPaymentRequirements({
            payTo,
            amount,
            chainId,
        });

        const body = facilitator.buildVerifyRequest(paymentHeader, requirements);
        const result = await facilitator.settlePayment(body);

        console.log(`[cronos-x402] Result:`, JSON.stringify(result));

        if (result.event === "payment.settled" && result.txHash) {
            return {
                status: 200,
                success: true,
                txHash: result.txHash,
                blockNumber: result.blockNumber,
            };
        }

        return {
            status: 402,
            success: false,
            error: result.error || "Settlement failed",
        };
    } catch (error) {
        console.error(`[cronos-x402] Error:`, error);
        return {
            status: 500,
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

// =============================================================================
// ThirdWeb Configuration
// =============================================================================

// Validate configuration
if (!THIRDWEB_SECRET_KEY) {
    console.warn("⚠️ THIRDWEB_SECRET_KEY not set - ThirdWeb x402 payments will fail");
}
if (!SERVER_WALLET_ADDRESS) {
    console.warn("⚠️ THIRDWEB_SERVER_WALLET_ADDRESS not set - ThirdWeb x402 payments will fail");
}

// Server-side ThirdWeb client
const serverClient = THIRDWEB_SECRET_KEY
    ? createThirdwebClient({ secretKey: THIRDWEB_SECRET_KEY })
    : null;

// ThirdWeb x402 Facilitator (for non-Cronos chains)
const thirdwebFacilitator = serverClient && SERVER_WALLET_ADDRESS
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
 * MULTICHAIN SUPPORT:
 * - Cronos chains (338, 25): Use Cronos Labs facilitator
 * - Other EVM chains: Use ThirdWeb facilitator
 *
 * @param paymentData - The PAYMENT-SIGNATURE or X-PAYMENT header value from client
 * @param resourceUrl - Full URL of the resource being accessed
 * @param method - HTTP method (GET, POST, etc.)
 * @param amountWei - Amount to charge in USDC wei (6 decimals)
 * @param chainId - Optional explicit chain ID from X-CHAIN-ID header
 */
export async function handleX402Payment(
    paymentData: string | null | undefined,
    resourceUrl: string,
    method: string,
    amountWei: string = DEFAULT_PRICES.MCP_TOOL_CALL,
    chainId?: number,
): Promise<X402Result> {
    // Default chain if not specified (Cronos Testnet for x402 payments)
    const resolvedChainId = chainId || CHAIN_IDS.cronosTestnet;
    const useCronos = isCronosChain(resolvedChainId);

    console.log(`[x402] handleX402Payment for ${resourceUrl}`);
    console.log(`[x402] chainId: ${resolvedChainId} (${useCronos ? "CRONOS" : "THIRDWEB"})`);
    console.log(`[x402] paymentData present: ${!!paymentData}`);
    console.log(`[x402] amount: ${amountWei} wei ($${(parseInt(amountWei) / 1_000_000).toFixed(6)})`);
    console.log(`[x402] payTo: ${MERCHANT_WALLET_ADDRESS}`);

    // =========================================================================
    // CASE 1: No payment data - return 402 Payment Required
    // =========================================================================
    if (!paymentData) {
        if (useCronos) {
            console.log(`[x402] No payment - returning Cronos x402 V1 402 response`);
            const cronosResponse = createCronos402Response({
                payTo: MERCHANT_WALLET_ADDRESS!,
                amount: amountWei,
                chainId: resolvedChainId,
                description: "Compose.Market Service Execution",
                resource: resourceUrl,
            });
            return {
                status: 402,
                responseBody: cronosResponse,
                responseHeaders: { "X402-Version": "1" },
            };
        } else {
            console.log(`[x402] No payment - using ThirdWeb for 402 response`);
            if (!thirdwebFacilitator || !serverClient) {
                return {
                    status: 500,
                    responseBody: { error: "ThirdWeb payment system not configured" },
                    responseHeaders: {},
                };
            }

            const chainObject = getChainObject(resolvedChainId);
            const usdcAddress = getUsdcAddress(resolvedChainId);

            const result = await settlePayment({
                resourceUrl,
                method,
                paymentData: null,
                payTo: MERCHANT_WALLET_ADDRESS!,
                network: chainObject,
                price: {
                    amount: amountWei,
                    asset: { address: usdcAddress },
                },
                facilitator: thirdwebFacilitator,
            });

            return {
                status: result.status,
                responseBody: (result as { responseBody: unknown }).responseBody,
                responseHeaders: result.responseHeaders as Record<string, string>,
            };
        }
    }

    // =========================================================================
    // CASE 2: Payment data present - verify and settle
    // =========================================================================
    if (useCronos) {
        console.log(`[x402] Settling via Cronos Labs facilitator`);
        const result = await verifyAndSettleCronosPayment({
            paymentHeader: paymentData,
            payTo: MERCHANT_WALLET_ADDRESS!,
            amount: amountWei,
            chainId: resolvedChainId,
        });

        console.log(`[x402] Cronos result: status=${result.status}, success=${result.success}`);

        return {
            status: result.status,
            responseBody: result.success
                ? { success: true, txHash: result.txHash, blockNumber: result.blockNumber }
                : { error: result.error },
            responseHeaders: result.txHash
                ? { "X-Transaction-Hash": result.txHash, "X-PAYMENT-RESPONSE": result.txHash }
                : {},
        };
    } else {
        console.log(`[x402] Settling via ThirdWeb facilitator`);
        if (!thirdwebFacilitator || !serverClient) {
            return {
                status: 500,
                responseBody: { error: "ThirdWeb payment system not configured" },
                responseHeaders: {},
            };
        }

        const chainObject = getChainObject(resolvedChainId);
        const usdcAddress = getUsdcAddress(resolvedChainId);

        const result = await settlePayment({
            resourceUrl,
            method,
            paymentData,
            payTo: MERCHANT_WALLET_ADDRESS!,
            network: chainObject,
            price: {
                amount: amountWei,
                asset: { address: usdcAddress },
            },
            facilitator: thirdwebFacilitator,
        });

        console.log(`[x402] ThirdWeb result status: ${result.status}`);

        return {
            status: result.status,
            responseBody: result.status === 200
                ? { success: true, receipt: (result as { paymentReceipt: unknown }).paymentReceipt }
                : (result as { responseBody: unknown }).responseBody,
            responseHeaders: result.responseHeaders as Record<string, string>,
        };
    }
}

/**
 * Check if request has valid active session (client-side budget management)
 */
export function hasActiveSession(headers: Record<string, string | undefined>): boolean {
    const sessionActive = headers["x-session-active"] === "true";
    const budgetRemaining = parseInt(headers["x-session-budget-remaining"] || "0", 10);
    return sessionActive && budgetRemaining > 0;
}

/**
 * Extract payment info from request headers
 */
export function extractPaymentInfo(headers: Record<string, string | string[] | undefined>): {
    paymentData: string | null;
    sessionActive: boolean;
    sessionBudgetRemaining: number;
    chainId: number | undefined;
} {
    // Check ThirdWeb format (PAYMENT-SIGNATURE)
    let paymentData = typeof headers["payment-signature"] === "string" ? headers["payment-signature"] :
        (typeof headers["PAYMENT-SIGNATURE"] === "string" ? headers["PAYMENT-SIGNATURE"] : null);

    // Also check Cronos format (X-PAYMENT)
    if (!paymentData) {
        paymentData = typeof headers["x-payment"] === "string" ? headers["x-payment"] :
            (typeof headers["X-PAYMENT"] === "string" ? headers["X-PAYMENT"] : null);
    }

    const sessionActive = headers["x-session-active"] === "true";
    const sessionBudgetRemaining = parseInt(
        typeof headers["x-session-budget-remaining"] === "string"
            ? headers["x-session-budget-remaining"]
            : "0",
        10
    );

    // Extract chain ID from X-CHAIN-ID header
    const chainIdHeader = headers["x-chain-id"] || headers["X-CHAIN-ID"];
    const chainId = typeof chainIdHeader === "string" ? parseInt(chainIdHeader, 10) : undefined;

    return {
        paymentData,
        sessionActive,
        sessionBudgetRemaining,
        chainId: chainId && !isNaN(chainId) ? chainId : undefined,
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
        "Payment-Required": "true",
        "Payment-Method": details.method,
        "Payment-Id": details.id,
        "Payment-Network": details.network,
        "Payment-Asset": details.assetAddress,
        "Payment-Asset-Symbol": details.assetSymbol,
        "Payment-Payee": details.payee,
        "Payment-Scheme": details.x402.scheme,
        "Payment-Amount": args.pricing.amount,
    };
}

// Export configuration for reference
export {
    SERVER_WALLET_ADDRESS,
    MERCHANT_WALLET_ADDRESS,
    isCronosChain,
    getUsdcAddress,
    CHAIN_IDS,
};
