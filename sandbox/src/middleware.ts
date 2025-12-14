import { type Request, type Response, type NextFunction } from "express";
import { createThirdwebClient } from "thirdweb";

import { extractPaymentInfo, buildPaymentRequiredHeaders, handleX402Payment } from "../../shared/payment.js";
import { THIRDWEB_CHAIN_IDS } from "./schema.js";

// Initialize Thirdweb Client
const client = createThirdwebClient({
    clientId: process.env.NEXT_PUBLIC_THIRDWEB_CLIENT_ID || process.env.THIRDWEB_CLIENT_ID || "",
    secretKey: process.env.THIRDWEB_SECRET_KEY || "",
});

// Initialize Server Wallet (Facilitator)
// This must be an ERC4337 Smart Account for x402 to work as a facilitator


/**
 * x402 Middleware
 * 
 * Intercepts requests and enforces payment or active session.
 * 
 * @param options Configuration for the middleware
 * @param options.serviceId The ID of the service requesting payment (e.g., "connector", "mcp")
 * @param options.pricing Default pricing if not specified per-request
 */
export function x402Middleware(options: {
    serviceId: string;
    pricing?: {
        amount: string; // in wei
        tokenAddress: string;
        chainId: number;
    };
}) {
    return async (req: Request, res: Response, next: NextFunction) => {
        // Skip OPTIONS requests (CORS)
        if (req.method === "OPTIONS") {
            return next();
        }

        // skip health checks
        if (req.path === "/health" || req.path === "/") {
            return next();
        }

        // 1. Extract payment info from headers
        const { paymentData, sessionActive, sessionBudgetRemaining } = extractPaymentInfo(req.headers);

        // 2. Check for Active Session (Client-side budget management)
        // If the client claims an active session with budget, we trust them for now 
        // (in a real prod env, we would verify the session token signature here too)
        // For this implementation, we still require x402 settlement for the "session" usage if possible,
        // OR we just allow it if the client signed a "session start" tx previously.
        // 
        // However, the requirement says "achieve signless txs through active sessions".
        // This usually means the client has a session key that signs the request.
        // The x402 protocol supports "upto" schemes where you authorize a cap.
        if (sessionActive && sessionBudgetRemaining > 0) {
            return next();
        }

        // If paymentData is present, we try to settle it.
        if (paymentData) {
            try {
                // Use the helper which handles facilitator and settlePayment correctly
                const result = await handleX402Payment(
                    paymentData,
                    req.protocol + "://" + req.get("host") + req.originalUrl,
                    req.method,
                    options.pricing?.amount
                );

                if (result.status === 200) {
                    (req as any).payment = result.responseBody;
                    // Set response headers if any
                    if (result.responseHeaders) {
                        Object.entries(result.responseHeaders).forEach(([k, v]) => res.setHeader(k, v));
                    }
                    return next();
                } else {
                    return res.status(result.status).set(result.responseHeaders).json(result.responseBody);
                }

            } catch (error) {
                console.error("x402 Payment Error:", error);
                return res.status(500).json({ error: "Internal Server Error during payment processing" });
            }
        }

        // 3. No payment data provided -> Return 402
        // We require payment for all other requests
        return res.status(402).json({
            error: "Payment Required",
            message: "This endpoint requires x402 payment.",
            ...buildPaymentRequiredHeaders(
                {
                    method: "x402",
                    id: "default",
                    network: String(options.pricing?.chainId || 43113),
                    assetAddress: options.pricing?.tokenAddress || "0x5425890298aed601595a70ab815c96711a31bc65",
                    assetSymbol: "USDC",
                    payee: process.env.THIRDWEB_SERVER_WALLET_ADDRESS || "",
                    x402: { scheme: "upto" }
                },
                {
                    pricing: {
                        amount: options.pricing?.amount || "0"
                    }
                } as any
            )
        });
    };
}
