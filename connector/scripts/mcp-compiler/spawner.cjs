/**
 * MCP Server Spawner (Local)
 * 
 * Spawns MCP servers locally with transport fallback:
 * npx → stdio → http → docker
 * 
 * Takes server data JSON directly (from mcpServers.json) and extracts
 * spawn config from packages[].spawn
 * 
 * Usage: node spawner.cjs '<server_json>'
 */

const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { spawn } = require("child_process");

const SPAWN_TIMEOUT_MS = 30000;
const RETRY_DELAY_MS = 1000;

const TRANSPORT_PRIORITY = ["npx", "stdio", "http", "docker"];

/**
 * Extract spawn config from server data
 */
function extractSpawnConfig(serverData) {
  const config = {
    transport: serverData.transport || "stdio",
    package: null,
    command: null,
    args: [],
    env: {},
    remoteUrl: null,
    protocol: null,
    image: null,
    remotes: serverData.remotes || []
  };

  // Check packages array for spawn config
  const packages = serverData.packages || [];
  for (const pkg of packages) {
    if (pkg.spawn && pkg.spawn.command) {
      // Explicit spawn config
      config.transport = "stdio";
      config.command = pkg.spawn.command;
      config.args = pkg.spawn.args || [];
      config.env = pkg.spawn.env || {};
      
      // If npx command, also set package for fallback
      if (pkg.spawn.command === "npx" && pkg.spawn.args?.length > 0) {
        config.package = pkg.spawn.args[pkg.spawn.args.length - 1];
      }
      return config;
    }
    
    // npm package without explicit spawn
    if ((pkg.registryType === "npm" || pkg.registryType === "npmjs") && pkg.identifier) {
      config.transport = "npx";
      config.package = pkg.identifier;
      return config;
    }
    
    // pypi package
    if (pkg.registryType === "pypi" && pkg.identifier) {
      config.transport = "stdio";
      config.command = "uvx";
      const moduleName = pkg.identifier.split("/").pop() || pkg.identifier;
      config.args = ["--from", pkg.identifier, moduleName];
      return config;
    }
  }

  // Check for HTTP remotes
  if (config.remotes && config.remotes.length > 0) {
    config.transport = "http";
    const remote = config.remotes.find(r => r.type === "streamable-http") ||
                   config.remotes.find(r => r.type === "sse") ||
                   config.remotes[0];
    config.remoteUrl = remote.url;
    config.protocol = remote.type;
    return config;
  }

  // Check for remoteUrl at top level
  if (serverData.remoteUrl) {
    config.transport = "http";
    config.remoteUrl = serverData.remoteUrl;
    return config;
  }

  // Check for docker image
  if (serverData.image) {
    config.transport = "docker";
    config.image = serverData.image;
    return config;
  }

  return null;
}

/**
 * Try to spawn with stdio/npx transport
 */
async function tryStdioSpawn(serverId, config, transportType) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`Spawn timeout after ${SPAWN_TIMEOUT_MS}ms`));
    }, SPAWN_TIMEOUT_MS);

    let childProcess = null;
    let client = null;

    const cleanup = () => {
      clearTimeout(timeoutId);
      if (childProcess) {
        try {
          childProcess.kill("SIGTERM");
        } catch (e) {}
      }
    };

    (async () => {
      try {
        let command, args;
        const env = { ...process.env, ...config.env };

        if (transportType === "npx" && config.package) {
          command = "npx";
          args = ["-y", config.package];
        } else if (transportType === "stdio" && config.command) {
          command = config.command;
          args = config.args || [];
        } else {
          throw new Error(`Missing config for ${transportType}`);
        }

        console.log(`[Spawner] Spawning: ${command} ${args.join(" ")}`);

        // Create transport
        const transport = new StdioClientTransport({
          command,
          args,
          env
        });

        // Create MCP client
        client = new Client({
          name: "mcp-compiler",
          version: "1.0.0"
        }, {
          capabilities: {}
        });

        // Connect and list tools
        await client.connect(transport);
        const { tools } = await client.listTools();

        // Extract tool info
        const toolInfo = tools.map(t => ({
          name: t.name,
          description: t.description || "",
          inputSchema: t.inputSchema || {}
        }));

        // Close connection
        await client.close();
        cleanup();

        resolve({
          success: true,
          transport: transportType,
          tools: toolInfo,
          toolCount: toolInfo.length
        });

      } catch (error) {
        cleanup();
        reject(error);
      }
    })();
  });
}

/**
 * Try HTTP/SSE transport
 */
async function tryHttpSpawn(config) {
  const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
  
  let endpoint = config.remoteUrl.replace(/\/$/, "");
  const protocol = config.protocol || "sse";
  
  if (protocol === "sse" && !endpoint.endsWith("/sse")) {
    endpoint += "/sse";
  } else if (protocol === "streamable-http" && !endpoint.endsWith("/mcp")) {
    endpoint += "/mcp";
  }

  console.log(`[Spawner] HTTP endpoint: ${endpoint}`);

  try {
    // First, try initialize
    const initResponse = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "mcp-compiler", version: "1.0.0" }
        },
        id: 0
      }),
      timeout: 15000
    });

    if (!initResponse.ok) {
      throw new Error(`HTTP ${initResponse.status}`);
    }

    // Now try tools/list
    const toolsResponse = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/list",
        params: {},
        id: 1
      }),
      timeout: 15000
    });

    if (!toolsResponse.ok) {
      throw new Error(`HTTP ${toolsResponse.status}`);
    }

    const contentType = toolsResponse.headers.get("content-type") || "";
    let tools = [];

    if (contentType.includes("application/json")) {
      const data = await toolsResponse.json();
      if (data.result && data.result.tools) {
        tools = data.result.tools.map(t => ({
          name: t.name,
          description: t.description || "",
          inputSchema: t.inputSchema || {}
        }));
      }
    } else if (contentType.includes("text/event-stream")) {
      const text = await toolsResponse.text();
      const lines = text.split("\n");
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.result && data.result.tools) {
              tools = data.result.tools.map(t => ({
                name: t.name,
                description: t.description || "",
                inputSchema: t.inputSchema || {}
              }));
            }
          } catch (e) {}
        }
      }
    }

    return {
      success: true,
      transport: "http",
      protocol: protocol,
      remoteUrl: config.remoteUrl,
      tools,
      toolCount: tools.length
    };

  } catch (error) {
    throw new Error(`HTTP transport failed: ${error.message}`);
  }
}

/**
 * Try Docker transport
 */
async function tryDockerSpawn(config) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`Docker spawn timeout after ${SPAWN_TIMEOUT_MS}ms`));
    }, SPAWN_TIMEOUT_MS);

    let childProcess = null;

    const cleanup = () => {
      clearTimeout(timeoutId);
      if (childProcess) {
        try {
          childProcess.kill("SIGTERM");
        } catch (e) {}
      }
    };

    (async () => {
      try {
        const command = "docker";
        const args = ["run", "--rm", "-i", config.image];

        console.log(`[Spawner] Docker: ${command} ${args.join(" ")}`);

        const transport = new StdioClientTransport({
          command,
          args,
          env: process.env
        });

        const client = new Client({
          name: "mcp-compiler",
          version: "1.0.0"
        }, {
          capabilities: {}
        });

        await client.connect(transport);
        const { tools } = await client.listTools();

        const toolInfo = tools.map(t => ({
          name: t.name,
          description: t.description || "",
          inputSchema: t.inputSchema || {}
        }));

        await client.close();
        cleanup();

        resolve({
          success: true,
          transport: "docker",
          tools: toolInfo,
          toolCount: toolInfo.length
        });

      } catch (error) {
        cleanup();
        reject(error);
      }
    })();
  });
}

/**
 * Spawn server with transport fallback
 */
async function spawnWithFallback(serverData) {
  const serverId = serverData.id || "unknown";
  
  const results = {
    serverId,
    success: false,
    transport: null,
    tools: [],
    toolCount: 0,
    failedTransports: [],
    error: null
  };

  const config = extractSpawnConfig(serverData);
  
  if (!config) {
    results.error = "No spawn config found in server data";
    return results;
  }

  // Build transport priority list
  let transports = [...TRANSPORT_PRIORITY];
  
  // If config specifies transport, try it first
  if (config.transport) {
    transports = transports.filter(t => t !== config.transport);
    transports.unshift(config.transport);
  }

  // Try each transport
  for (const transportType of transports) {
    // Check if this transport is possible with our config
    if (transportType === "npx" && !config.package) continue;
    if (transportType === "stdio" && !config.command) continue;
    if (transportType === "http" && !config.remoteUrl && !config.remotes?.length) continue;
    if (transportType === "docker" && !config.image) continue;

    console.log(`[Spawner] Trying ${serverId} with ${transportType}...`);

    try {
      let result;
      
      if (transportType === "npx" || transportType === "stdio") {
        result = await tryStdioSpawn(serverId, config, transportType);
      } else if (transportType === "http") {
        // Handle remotes array
        const httpConfig = { ...config };
        if (config.remotes?.length) {
          const remote = config.remotes.find(r => r.type === "streamable-http") ||
                         config.remotes.find(r => r.type === "sse") ||
                         config.remotes[0];
          httpConfig.remoteUrl = remote.url;
          httpConfig.protocol = remote.type;
        }
        result = await tryHttpSpawn(httpConfig);
      } else if (transportType === "docker") {
        result = await tryDockerSpawn(config);
      }

      if (result && result.success) {
        return {
          ...results,
          success: true,
          transport: result.transport,
          tools: result.tools,
          toolCount: result.toolCount,
          protocol: result.protocol,
          remoteUrl: result.remoteUrl
        };
      }

    } catch (error) {
      console.log(`[Spawner] ${transportType} failed for ${serverId}: ${error.message}`);
      results.failedTransports.push({
        transport: transportType,
        error: error.message
      });
    }

    // Delay between attempts
    await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
  }

  results.error = `All transports failed: ${results.failedTransports.map(t => t.transport).join(", ")}`;
  return results;
}

/**
 * Main entry point
 */
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.error("Usage: node spawner.cjs '<server_json>'");
    console.error("       node spawner.cjs --file <path_to_json>");
    console.error("Example: node spawner.cjs '{\"id\":\"test\",\"packages\":[{\"spawn\":{\"command\":\"npx\",\"args\":[\"-y\",\"pkg\"]}}]}'");
    process.exit(1);
  }

  try {
    let serverData;
    
    // Check if --file flag is used
    if (args[0] === "--file" && args[1]) {
      const fs = require("fs");
      const content = fs.readFileSync(args[1], "utf8");
      serverData = JSON.parse(content);
      console.log(`[Spawner] Loaded server from file: ${args[1]}`);
    } else {
      serverData = JSON.parse(args[0]);
    }
    
    console.log(`[Spawner] Spawning server: ${serverData.id || "unknown"}`);
    
    const result = await spawnWithFallback(serverData);
    console.log(JSON.stringify(result));  // Compact JSON on single line
    
    process.exit(result.success ? 0 : 1);

  } catch (error) {
    console.log(JSON.stringify({
      serverId: "unknown",
      success: false,
      error: error.message
    }));
    process.exit(1);
  }
}

module.exports = {
  extractSpawnConfig,
  spawnWithFallback,
  tryStdioSpawn,
  tryHttpSpawn,
  tryDockerSpawn,
  TRANSPORT_PRIORITY
};

if (require.main === module) {
  main().catch(console.error);
}