/**
 * Lyria RealTime Socket Server
 *
 * WebSocket proxy for Google Lyria RealTime music generation.
 * Handles bidirectional streaming between clients and Lyria API.
 *
 * Features:
 * - Real-time music generation with continuous steering
 * - Session management for multiple concurrent users
 * - Play/pause/stop/reset transport controls
 * - BPM, temperature, scale configuration
 *
 * Audio Output: 16-bit PCM, 48kHz stereo
 *
 * @see https://ai.google.dev/gemini-api/docs/music-generation
 */
import "dotenv/config";
import express, { type Request, type Response } from "express";
import cors from "cors";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import { GoogleGenAI } from "@google/genai";

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
        service: "socket-lyria",
        version: "0.1.0",
        activeSessions: sessions.size,
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
const wss = new WebSocketServer({ server, path: "/lyria" });

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
// Start Server
// =============================================================================

server.listen(PORT, () => {
    console.log(`[socket] Lyria RealTime server listening on port ${PORT}`);
    console.log(`[socket] WebSocket endpoint: ws://localhost:${PORT}/lyria`);
    console.log(`[socket] Health check: http://localhost:${PORT}/health`);
});
