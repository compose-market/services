/**
 * Compose Socket Server
 *
 * Multi-service WebSocket server:
 * - /lyria   — Google Lyria RealTime music generation
 * - /whatsapp — Baileys WhatsApp Web QR pairing
 *
 * @see https://ai.google.dev/gemini-api/docs/music-generation
 */
import "dotenv/config";
import express, { type Request, type Response } from "express";
import cors from "cors";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import { GoogleGenAI } from "@google/genai";
import { createClient, type RedisClientType } from "redis";
import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    type WASocket,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import QRCode from "qrcode";
import path from "path";
import fs from "fs";
import os from "os";

// =============================================================================
// Configuration
// =============================================================================

const PORT = process.env.SOCKET_PORT || 4004;
const LYRIA_API_KEY = process.env.LYRIA_REALTIME_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY;

if (!LYRIA_API_KEY) {
    console.error("[socket] LYRIA_REALTIME_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY required");
    process.exit(1);
}

// Initialize Google GenAI client with v1alpha for Lyria
const genaiClient = new GoogleGenAI({
    apiKey: LYRIA_API_KEY,
    httpOptions: { apiVersion: "v1alpha" },
});

// =============================================================================
// Types
// =============================================================================

interface LyriaSession {
    sessionId: string;
    googleSession: any; // Google SDK session type
    createdAt: number;
    lastActivity: number;
    config: {
        bpm: number;
        temperature: number;
        scale?: string;
    };
}

interface ClientMessage {
    type: "connect" | "prompt" | "config" | "play" | "pause" | "stop" | "reset" | "disconnect";
    prompt?: string;
    weightedPrompts?: Array<{ text: string; weight: number }>;
    config?: {
        bpm?: number;
        temperature?: number;
        scale?: string;
        audioFormat?: string;
        sampleRateHz?: number;
    };
}

// =============================================================================
// Session Management
// =============================================================================

const sessions = new Map<string, LyriaSession>();

// Clean up stale sessions every 5 minutes
setInterval(() => {
    const now = Date.now();
    const STALE_THRESHOLD = 30 * 60 * 1000; // 30 minutes

    for (const [sessionId, session] of sessions) {
        if (now - session.lastActivity > STALE_THRESHOLD) {
            console.log(`[socket] Cleaning up stale session: ${sessionId}`);
            sessions.delete(sessionId);
        }
    }
}, 5 * 60 * 1000);

// =============================================================================
// Express App for Health Checks
// =============================================================================

const app = express();

app.use(cors({
    origin: function (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) {
        if (!origin) return callback(null, true);

        const allowedOrigins = [
            'http://localhost:5173',
            'http://localhost:3000',
            'https://compose.market',
            'https://www.compose.market',
        ];

        if (allowedOrigins.includes(origin) || /^https:\/\/[\w-]+\.compose\.market$/.test(origin)) {
            return callback(null, true);
        }

        callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true,
}));

app.use(express.json());

// Health check endpoint
app.get("/health", (_req: Request, res: Response) => {
    res.json({
        status: "ok",
        timestamp: new Date().toISOString(),
        service: "socket",
        version: "0.2.0",
        lyriaSessions: sessions.size,
        whatsappSessions: waActiveSessions.size,
    });
});

// List active sessions
app.get("/sessions", (_req: Request, res: Response) => {
    const sessionList = Array.from(sessions.entries()).map(([id, session]) => ({
        sessionId: id,
        createdAt: session.createdAt,
        lastActivity: session.lastActivity,
        config: session.config,
    }));

    res.json({ sessions: sessionList, total: sessionList.length });
});

// =============================================================================
// WebSocket Server
// =============================================================================

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", async (ws: WebSocket, req) => {
    const sessionId = crypto.randomUUID();
    console.log(`[socket] New Lyria connection: ${sessionId} from ${req.socket.remoteAddress}`);

    let googleSession: any = null;

    // Send session ID to client
    ws.send(JSON.stringify({
        type: "session",
        sessionId,
        message: "Connected to Lyria RealTime. Send 'connect' to start music session.",
    }));

    ws.on("message", async (data: Buffer | ArrayBuffer | Buffer[]) => {
        try {
            const message = JSON.parse(data.toString()) as ClientMessage;

            switch (message.type) {
                case "connect": {
                    // Connect to Lyria RealTime
                    console.log(`[socket] Starting Lyria session for ${sessionId}`);

                    googleSession = await genaiClient.live.music.connect({
                        model: "models/lyria-realtime-exp",
                        callbacks: {
                            onmessage: (msg: any) => {
                                // Forward audio chunks to client
                                if (msg.serverContent?.audioChunks) {
                                    for (const chunk of msg.serverContent.audioChunks) {
                                        ws.send(JSON.stringify({
                                            type: "audio",
                                            data: chunk.data, // Base64 PCM audio
                                            format: "pcm16",
                                            sampleRate: 48000,
                                            channels: 2,
                                        }));
                                    }
                                }

                                // Forward any other messages
                                if (msg.serverContent?.modelTurn) {
                                    ws.send(JSON.stringify({
                                        type: "status",
                                        modelTurn: msg.serverContent.modelTurn,
                                    }));
                                }
                            },
                            onerror: (error: ErrorEvent) => {
                                console.error(`[socket] Lyria error for ${sessionId}:`, error);
                                ws.send(JSON.stringify({
                                    type: "error",
                                    message: error.message || String(error),
                                }));
                            },
                            onclose: () => {
                                console.log(`[socket] Lyria stream closed for ${sessionId}`);
                                ws.send(JSON.stringify({
                                    type: "closed",
                                    message: "Lyria stream closed",
                                }));
                            },
                        },
                    });

                    // Store session
                    sessions.set(sessionId, {
                        sessionId,
                        googleSession,
                        createdAt: Date.now(),
                        lastActivity: Date.now(),
                        config: { bpm: 90, temperature: 1.0 },
                    });

                    ws.send(JSON.stringify({
                        type: "connected",
                        message: "Lyria session ready. Set prompts and config, then call 'play'.",
                    }));
                    break;
                }

                case "prompt": {
                    if (!googleSession) {
                        ws.send(JSON.stringify({ type: "error", message: "Not connected. Send 'connect' first." }));
                        break;
                    }

                    const prompts = message.weightedPrompts || [
                        { text: message.prompt || "ambient electronic", weight: 1.0 }
                    ];

                    await googleSession.setWeightedPrompts({
                        weightedPrompts: prompts,
                    });

                    const session = sessions.get(sessionId);
                    if (session) session.lastActivity = Date.now();

                    ws.send(JSON.stringify({
                        type: "ack",
                        action: "prompt",
                        prompts,
                    }));
                    break;
                }

                case "config": {
                    if (!googleSession) {
                        ws.send(JSON.stringify({ type: "error", message: "Not connected. Send 'connect' first." }));
                        break;
                    }

                    const config = message.config || {};

                    await googleSession.setMusicGenerationConfig({
                        musicGenerationConfig: {
                            bpm: config.bpm || 90,
                            temperature: config.temperature || 1.0,
                            audioFormat: config.audioFormat || "pcm16",
                            sampleRateHz: config.sampleRateHz || 48000,
                            ...(config.scale && { scale: config.scale }),
                        },
                    });

                    const session = sessions.get(sessionId);
                    if (session) {
                        session.lastActivity = Date.now();
                        session.config = {
                            bpm: config.bpm || session.config.bpm,
                            temperature: config.temperature || session.config.temperature,
                            scale: config.scale || session.config.scale,
                        };
                    }

                    ws.send(JSON.stringify({
                        type: "ack",
                        action: "config",
                        config: session?.config,
                    }));
                    break;
                }

                case "play": {
                    if (!googleSession) {
                        ws.send(JSON.stringify({ type: "error", message: "Not connected. Send 'connect' first." }));
                        break;
                    }

                    await googleSession.play();

                    const session = sessions.get(sessionId);
                    if (session) session.lastActivity = Date.now();

                    ws.send(JSON.stringify({ type: "ack", action: "play" }));
                    break;
                }

                case "pause": {
                    if (!googleSession) {
                        ws.send(JSON.stringify({ type: "error", message: "Not connected." }));
                        break;
                    }

                    await googleSession.pause();
                    ws.send(JSON.stringify({ type: "ack", action: "pause" }));
                    break;
                }

                case "stop": {
                    if (!googleSession) {
                        ws.send(JSON.stringify({ type: "error", message: "Not connected." }));
                        break;
                    }

                    await googleSession.stop();
                    ws.send(JSON.stringify({ type: "ack", action: "stop" }));
                    break;
                }

                case "reset": {
                    if (!googleSession) {
                        ws.send(JSON.stringify({ type: "error", message: "Not connected." }));
                        break;
                    }

                    await googleSession.resetContext();
                    ws.send(JSON.stringify({ type: "ack", action: "reset" }));
                    break;
                }

                case "disconnect": {
                    console.log(`[socket] Client requested disconnect: ${sessionId}`);
                    if (googleSession) {
                        await googleSession.stop();
                    }
                    sessions.delete(sessionId);
                    ws.close();
                    break;
                }

                default:
                    ws.send(JSON.stringify({
                        type: "error",
                        message: `Unknown message type: ${message.type}`,
                    }));
            }
        } catch (error) {
            console.error(`[socket] Error handling message for ${sessionId}:`, error);
            ws.send(JSON.stringify({
                type: "error",
                message: error instanceof Error ? error.message : String(error),
            }));
        }
    });

    ws.on("close", () => {
        console.log(`[socket] Connection closed: ${sessionId}`);
        sessions.delete(sessionId);
    });

    ws.on("error", (error) => {
        console.error(`[socket] WebSocket error for ${sessionId}:`, error);
        sessions.delete(sessionId);
    });
});

// =============================================================================
// WhatsApp — Baileys QR Pairing
// =============================================================================

// Redis client for storing WhatsApp auth state and channel bindings
let redisClient: RedisClientType | null = null;

async function getRedis(): Promise<RedisClientType> {
    if (redisClient?.isOpen) return redisClient;

    const endpoint = process.env.REDIS_DATABASE_PUBLIC_ENDPOINT;
    const password = process.env.REDIS_DEFAULT_PASSWORD;
    const useTls = process.env.REDIS_TLS === "true";

    if (!endpoint || !password) {
        throw new Error("Redis config missing: REDIS_DATABASE_PUBLIC_ENDPOINT + REDIS_DEFAULT_PASSWORD");
    }

    const [host, portStr] = endpoint.split(":");
    const port = parseInt(portStr, 10);

    redisClient = createClient({
        socket: useTls ? { host, port, tls: true as const } : { host, port },
        password,
    });

    redisClient.on("error", (err) => console.error("[redis] Error:", err));
    await redisClient.connect();
    console.log("[whatsapp] Redis connected");
    return redisClient;
}

// Track active WhatsApp sessions per userId
const waActiveSessions = new Map<string, { sock: WASocket; ws: WebSocket }>();

// Auth state directory (per user)
const WA_AUTH_DIR = path.join(os.tmpdir(), "compose-wa-auth");
fs.mkdirSync(WA_AUTH_DIR, { recursive: true });

const wssWhatsApp = new WebSocketServer({ noServer: true });

wssWhatsApp.on("connection", async (ws: WebSocket, req) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const userId = url.searchParams.get("userId");

    if (!userId) {
        ws.send(JSON.stringify({ type: "error", message: "userId query parameter required" }));
        ws.close();
        return;
    }

    console.log(`[whatsapp] New connection for user: ${userId}`);


    const redis = await getRedis();
    const existingBinding = await redis.get(`backpack:channel:${userId}:whatsapp`);
    if (existingBinding) {
        ws.send(JSON.stringify({ type: "already_connected", message: "WhatsApp already linked" }));
        ws.close();
        return;
    }

    // Cleanup any stale session
    const existingSession = waActiveSessions.get(userId);
    if (existingSession) {
        console.log(`[whatsapp] Cleaning up existing session for ${userId}`);
        try { existingSession.sock.end(undefined); } catch { /* ignore */ }
        waActiveSessions.delete(userId);
    }

    const authDir = path.join(WA_AUTH_DIR, userId);

    // Clean stale auth if no active binding exists (e.g. after disconnect)
    if (fs.existsSync(authDir)) {
        console.log(`[whatsapp] Cleaning stale auth dir for ${userId} (no active binding)`);
        try { fs.rmSync(authDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    fs.mkdirSync(authDir, { recursive: true });

    let pairingPhone: string | null = null;
    let clientClosed = false;

    // =========================================================================
    // Recursive session starter — handles reconnects after QR scan (code 515)
    // =========================================================================
    async function startBaileysSession() {
        if (clientClosed) return;

        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            browser: ["Compose Market", "Chrome", "1.0.0"],
            generateHighQualityLinkPreview: false,
        });

        waActiveSessions.set(userId!, { sock, ws });

        sock.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect, qr } = update;

            // QR code — only send if not in phone pairing mode
            if (qr && !pairingPhone) {
                try {
                    const qrDataUrl = await QRCode.toDataURL(qr, {
                        width: 256, margin: 2,
                        color: { dark: "#000000", light: "#ffffff" },
                    });
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: "qr", qr: qrDataUrl }));
                        console.log(`[whatsapp] QR sent to user ${userId}`);
                    }
                } catch (err) {
                    console.error(`[whatsapp] QR generation error:`, err);
                }
            }

            // Successfully paired!
            if (connection === "open") {
                const phoneNumber = sock.user?.id?.split(":")[0] || sock.user?.id || "unknown";
                console.log(`[whatsapp] Connected for user ${userId}: ${phoneNumber}`);

                const binding = JSON.stringify({ waId: phoneNumber, boundAt: Date.now() });
                await redis.set(`backpack:channel:${userId}:whatsapp`, binding);

                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        type: "connected", phoneNumber,
                        message: "WhatsApp linked successfully",
                    }));
                }

                waActiveSessions.delete(userId!);
                ws.close();
            }

            // Connection closed — reconnect if needed (e.g. code 515 after QR scan)
            if (connection === "close") {
                const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                console.log(`[whatsapp] Connection closed for ${userId}, status: ${statusCode}, reconnect: ${shouldReconnect}`);

                if (shouldReconnect && !clientClosed) {
                    console.log(`[whatsapp] Reconnecting for ${userId}...`);
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: "reconnecting", message: "Completing pairing..." }));
                    }
                    setTimeout(() => startBaileysSession(), 1000);
                } else if (!shouldReconnect) {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: "disconnected", message: "Session logged out" }));
                    }
                    waActiveSessions.delete(userId!);
                    try { fs.rmSync(authDir, { recursive: true, force: true }); } catch { /* ignore */ }
                }
            }
        });

        sock.ev.on("creds.update", saveCreds);

        // Phone pairing code — request after socket initializes
        if (pairingPhone) {
            setTimeout(async () => {
                try {
                    const code = await sock.requestPairingCode(pairingPhone!);
                    console.log(`[whatsapp] Pairing code issued for ${userId}: ${code}`);
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: "pairing_code", code }));
                    }
                } catch (err) {
                    console.error(`[whatsapp] Pairing code error for ${userId}:`, err);
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: "error",
                            message: err instanceof Error ? err.message : "Failed to generate pairing code",
                        }));
                    }
                }
            }, 3000);
        }
    }

    try {
        // Client messages
        ws.on("message", async (data: Buffer | ArrayBuffer | Buffer[]) => {
            try {
                const msg = JSON.parse(data.toString());

                if (msg.type === "disconnect") {
                    console.log(`[whatsapp] User ${userId} requested disconnect`);
                    await redis.del(`backpack:channel:${userId}:whatsapp`);
                    const session = waActiveSessions.get(userId!);
                    if (session) { try { session.sock.end(undefined); } catch { /* */ } }
                    try { fs.rmSync(authDir, { recursive: true, force: true }); } catch { /* */ }
                    waActiveSessions.delete(userId!);
                    ws.send(JSON.stringify({ type: "disconnected", message: "WhatsApp unlinked" }));
                    ws.close();
                }

                if (msg.type === "pair_phone" && msg.phone) {
                    // Strip everything non-numeric, remove leading + or 00
                    let phone = msg.phone.replace(/[^0-9]/g, "");
                    if (phone.startsWith("00")) phone = phone.slice(2);
                    console.log(`[whatsapp] Phone pairing requested for ${userId}: ${phone}`);
                    pairingPhone = phone;

                    // Kill existing session and restart with pairing code
                    const session = waActiveSessions.get(userId!);
                    if (session) { try { session.sock.end(undefined); } catch { /* */ } }
                    waActiveSessions.delete(userId!);
                    try { fs.rmSync(authDir, { recursive: true, force: true }); } catch { /* */ }
                    fs.mkdirSync(authDir, { recursive: true });

                    ws.send(JSON.stringify({ type: "pairing_code_pending", message: "Generating pairing code..." }));
                    await startBaileysSession();
                }


            } catch { /* ignore malformed */ }
        });

        // Client disconnect — stop reconnect loop
        ws.on("close", () => {
            console.log(`[whatsapp] Client disconnected: ${userId}`);
            clientClosed = true;
            const session = waActiveSessions.get(userId!);
            if (session) { try { session.sock.end(undefined); } catch { /* */ } }
            waActiveSessions.delete(userId!);
        });

        // Start initial session (QR mode)
        await startBaileysSession();

    } catch (err) {
        console.error(`[whatsapp] Setup error for ${userId}:`, err);
        ws.send(JSON.stringify({
            type: "error",
            message: err instanceof Error ? err.message : "Failed to initialize WhatsApp session",
        }));
        ws.close();
    }
});

// =============================================================================
// Start Server
// =============================================================================

// Manual upgrade routing — required when multiple WSS share one HTTP server
server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url || "/", `http://${request.headers.host}`).pathname;

    if (pathname === "/lyria") {
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit("connection", ws, request);
        });
    } else if (pathname === "/whatsapp") {
        wssWhatsApp.handleUpgrade(request, socket, head, (ws) => {
            wssWhatsApp.emit("connection", ws, request);
        });
    } else {
        socket.destroy();
    }
});

server.listen(PORT, () => {
    console.log(`[socket] Server listening on port ${PORT}`);
    console.log(`[socket] WebSocket endpoints:`);
    console.log(`[socket]   ws://localhost:${PORT}/lyria`);
    console.log(`[socket]   ws://localhost:${PORT}/whatsapp`);
    console.log(`[socket] Health: http://localhost:${PORT}/health`);
});
