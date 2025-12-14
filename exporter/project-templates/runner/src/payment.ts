/**
 * x402 Payment Module for Autonomous Execution
 * 
 * Enables the workflow runner to make x402-wrapped API calls
 * using the configured SERVER_PRIVATE_KEY for signing payments.
 */
import { createThirdwebClient, type ThirdwebClient } from "thirdweb";
import { privateKeyToAccount } from "thirdweb/wallets";
import { wrapFetchWithPayment } from "thirdweb/x402";
import { avalancheFuji, avalanche } from "thirdweb/chains";

// =============================================================================
// Configuration
// =============================================================================

const USE_MAINNET = process.env.USE_MAINNET === "true";
const CHAIN = USE_MAINNET ? avalanche : avalancheFuji;

// Server wallet for autonomous payments
const SERVER_PRIVATE_KEY = process.env.SERVER_PRIVATE_KEY as `0x${string}` | undefined;
const THIRDWEB_SECRET_KEY = process.env.THIRDWEB_SECRET_KEY;

// Maximum payment per API call (in wei, USDC has 6 decimals)
// Default: $0.01 = 10000 wei
const MAX_PAYMENT_WEI = BigInt(process.env.MAX_PAYMENT_WEI || "10000");

// =============================================================================
// Client Setup
// =============================================================================

let thirdwebClient: ThirdwebClient | null = null;
let paymentFetch: typeof fetch | null = null;

/**
 * Initialize the Thirdweb client with server credentials
 */
function initializeClient(): ThirdwebClient | null {
  if (thirdwebClient) return thirdwebClient;

  if (!THIRDWEB_SECRET_KEY) {
    console.warn("[payment] THIRDWEB_SECRET_KEY not set - x402 payments disabled");
    return null;
  }

  thirdwebClient = createThirdwebClient({
    secretKey: THIRDWEB_SECRET_KEY,
  });

  return thirdwebClient;
}

/**
 * Create a server wallet for autonomous payments
 */
function getServerWallet() {
  if (!SERVER_PRIVATE_KEY) {
    console.warn("[payment] SERVER_PRIVATE_KEY not set - autonomous payments disabled");
    return null;
  }

  const account = privateKeyToAccount({
    client: initializeClient()!,
    privateKey: SERVER_PRIVATE_KEY,
  });

  return {
    getAccount: () => account,
    getChain: () => CHAIN,
  };
}

// =============================================================================
// Payment-Wrapped Fetch
// =============================================================================

/**
 * Get a fetch function that automatically handles x402 payments
 * Uses the server wallet for signing payment headers
 */
export function getPaymentFetch(): typeof fetch {
  if (paymentFetch) return paymentFetch;

  const client = initializeClient();
  const wallet = getServerWallet();

  if (!client || !wallet) {
    console.log("[payment] Payment not configured - using standard fetch");
    paymentFetch = fetch;
    return fetch;
  }

  console.log(`[payment] Initialized autonomous payments with max ${MAX_PAYMENT_WEI} wei per call`);
  console.log(`[payment] Server wallet: ${wallet.getAccount().address}`);
  console.log(`[payment] Chain: ${CHAIN.name}`);

  const wrappedFetch = wrapFetchWithPayment(
    fetch,
    client,
    wallet as any,
    { maxValue: MAX_PAYMENT_WEI }
  ) as typeof fetch;

  paymentFetch = wrappedFetch;
  return wrappedFetch;
}

/**
 * Check if payment is properly configured
 */
export function isPaymentConfigured(): boolean {
  return !!(THIRDWEB_SECRET_KEY && SERVER_PRIVATE_KEY);
}

/**
 * Get payment configuration info for debugging
 */
export function getPaymentConfig() {
  return {
    configured: isPaymentConfigured(),
    chain: CHAIN.name,
    chainId: CHAIN.id,
    maxPaymentWei: MAX_PAYMENT_WEI.toString(),
    hasSecretKey: !!THIRDWEB_SECRET_KEY,
    hasPrivateKey: !!SERVER_PRIVATE_KEY,
  };
}

