/**
 * Metadata Extraction Utilities for MCP Server Sync
 */

export function validateGitHubRepoUrl(url: string | null | undefined): string | null {
    if (!url) return null;
    const normalized = url.trim().replace(/\.git$/, "").replace(/\/$/, "");
    if (!normalized.includes("github.com")) return null;
    return normalized;
}

export function extractGitHubRepo(html: string): string | null {
    // PRIORITY 1: mcp.so "Visit Server" link (contains actual repo)
    // Pattern: <a ...href="https://github.com/USER/REPO">Visit Server</a>
    const visitServerMatch = html.match(/<a[^>]*href="(https:\/\/github\.com\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+)"[^>]*>[\s\S]*?Visit Server/i);
    if (visitServerMatch && visitServerMatch[1]) {
        return validateGitHubRepoUrl(visitServerMatch[1]);
    }

    // FALLBACK: Generic GitHub URL (may catch metadata/wrong links)
    const githubMatch = html.match(/https:\/\/github\.com\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+/);
    if (githubMatch) return validateGitHubRepoUrl(githubMatch[0]);

    return null;
}

/**
 * Extract GitHub repository URL from mcp.so "Visit Server" button
 * This is more reliable than generic matching
 */
export function extractGitHubRepoFromMcpSo(html: string): string | null {
    // mcp.so has a "Visit Server" button that links to the actual GitHub repo
    // Format: <a href="https://github.com/USER/REPO">Visit Server</a>
    const visitServerMatch = html.match(/<a[^>]*href="(https:\/\/github\.com\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+)"[^>]*>[\s\S]{0,100}Visit Server/i);
    if (visitServerMatch && visitServerMatch[1]) {
        return validateGitHubRepoUrl(visitServerMatch[1]);
    }

    // Fallback to generic extraction
    return extractGitHubRepo(html);
}

/**
 * Extract NPM package from README sections (Setup, Command, Configuration)
 * Looks for npx commands in documentation
 */
export function extractNpmPackageFromReadme(html: string): string | undefined {
    // Look for npx commands in various formats
    const patterns = [
        // npx -y @scope/package-name
        /npx\s+-y\s+(@?[a-z0-9-]+(?:\/[a-z0-9-]+)?)/i,
        // npx @scope/package-name
        /npx\s+(@?[a-z0-9-]+(?:\/[a-z0-9-]+)?)/i,
        // "command": "npx", "args": ["-y", "@scope/package"]
        /"command"\s*:\s*"npx"[\s\S]{0,100}"args"\s*:\s*\[[^\]]*"(-y|--yes)"[^\]]*"(@?[a-z0-9-]+(?:\/[a-z0-9-]+)?)"/i,
    ];

    for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match) {
            // Get the package name from the last capture group
            const pkg = match[match.length - 1];
            if (pkg && pkg.length > 2 && !pkg.match(/^(-y|--yes)$/)) {
                return pkg;
            }
        }
    }

    return undefined;
}

/**
 * Extract Docker image from README code blocks
 * Looks for docker pull/run commands
 */
export function extractDockerImageFromReadme(html: string): string | undefined {
    const patterns = [
        // docker pull image:tag
        /docker\s+pull\s+([a-z0-9._\/-]+:[a-z0-9._-]+)/i,
        // docker run image:tag
        /docker\s+run[^"'\n]*\s+([a-z0-9._-]+\/[a-z0-9._-]+:[a-z0-9._-]+)/i,
        // "image": "registry/image:tag"
        /"image"\s*:\s*"([a-z0-9._\/-]+:[a-z0-9._-]+)"/i,
    ];

    for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match && match[1]) {
            const image = match[1];
            // Validate it looks like a valid image reference
            if ((image.includes('/') || image.includes(':')) && !image.includes('github.com')) {
                return image;
            }
        }
    }

    return undefined;
}

/**
 * Extract remote URL from PulseMCP server.json structure
 * server.json format: { mcpServers: { "serverName": { url: "https://..." } } }
 */
export function extractRemoteUrlFromServerJson(serverJson: any): string | undefined {
    if (!serverJson || !serverJson.mcpServers) {
        return undefined;
    }

    // Get first server from mcpServers object
    const serverKeys = Object.keys(serverJson.mcpServers);
    if (serverKeys.length === 0) {
        return undefined;
    }

    const firstServer = serverJson.mcpServers[serverKeys[0]];
    if (firstServer && firstServer.url) {
        return firstServer.url;
    }

    return undefined;
}

/**
 * Extract NPM package name from package.json
 * Also validates it looks like an MCP server package
 */
export function extractNpmFromPackageJson(packageJson: any): string | undefined {
    if (!packageJson || !packageJson.name) {
        return undefined;
    }

    const name = packageJson.name;

    // Basic validation - must be a string and not empty
    if (typeof name !== 'string' || name.trim().length === 0) {
        return undefined;
    }

    return name.trim();
}

export function extractNameFromHtml(html: string, fallback: string): string {
    const titleMatch = html.match(/<title>([^<]+)<\/title>/);
    if (titleMatch) {
        const title = titleMatch[1].trim()
            .replace(/\s*-\s*Glama$/i, "")
            .replace(/\s*-\s*mcp\.so$/i, "")
            .replace(/\s*-\s*PulseMCP$/i, "")
            .replace(/\s*\|\s*MCP\s*Server$/i, "")
            .trim();
        if (title && title !== "MCP Server" && title !== "Glama") return title;
    }
    const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
    if (h1Match) {
        const h1 = h1Match[1].trim();
        if (h1 && h1 !== "MCP Server") return h1;
    }
    return fallback;
}

export function cleanServerName(name: string): string {
    if (!name) return name;
    return name.trim()
        .replace(/^mcp-server-/i, "")
        .replace(/^server-/i, "")
        .replace(/-mcp-server$/i, "")
        .replace(/-server$/i, "")
        .replace(/-mcp$/i, "")
        .trim();
}

/**
 * Extract NPM package from Glama.ai HTML
 * Glama displays NPM packages in sidebar "Resources" section
 */
export function extractNpmPackageFromGlamaHtml(html: string): string | undefined {
    // PRIMARY: Look for NPM Package link in Resources sidebar
    // Format: <a href="https://www.npmjs.com/package/PACKAGE_NAME">NPM Package</a>
    const npmLinkMatch = html.match(/<a[^>]*href="https:\/\/www\.npmjs\.com\/package\/([^"]+)"[^>]*>.*?NPM Package.*?<\/a>/is);
    if (npmLinkMatch && npmLinkMatch[1]) {
        return npmLinkMatch[1].replace(/\\/g, ''); // Remove any trailing backslashes
    }

    // FALLBACK: Look for any npmjs.com link
    const npmMatch = html.match(/https:\/\/www\.npmjs\.com\/package\/(@?[a-z0-9-]+(?:\/[a-z0-9-]+)?)/i);
    if (npmMatch && npmMatch[1]) {
        const pkg = npmMatch[1].replace(/\\/g, '');
        // Exclude common false positives
        if (!pkg.includes('modelcontextprotocol') || pkg.includes('server')) {
            return pkg;
        }
    }

    return undefined;
}

/**
 * Extract Docker image from Glama.ai HTML
 * Docker images are usually in README code blocks
 */
export function extractDockerImageFromGlamaHtml(html: string): string | undefined {
    // Look for docker pull commands in code blocks
    const patterns = [
        /docker pull ([a-z0-9._\/-]+:[a-z0-9._-]+)/i,
        /docker run [^"']*([a-z0-9._-]+\/[a-z0-9._-]+:[a-z0-9._-]+)/i,
        /"image":\s*"([a-z0-9._\/-]+:[a-z0-9._-]+)"/i,
    ];

    for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match && match[1]) {
            const image = match[1];
            // Ensure it looks like a valid image reference
            if (image.includes('/') || image.includes(':')) {
                return image;
            }
        }
    }

    return undefined;
}

/**
 * Extract Server Config JSON from mcp.so HTML
 * mcp.so uses Next.js - config is in __NEXT_DATA__ script tag
 */
export function extractServerConfigFromMcpSo(html: string): {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
} | undefined {
    // mcp.so stores data in __NEXT_DATA__ script tag
    const nextDataMatch = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([^<]+)<\/script>/);

    if (!nextDataMatch) {
        return undefined;
    }

    try {
        const nextData = JSON.parse(nextDataMatch[1]);

        // Navigate through Next.js page props to find server config
        // Structure: props.pageProps.trpcState.json.queries[].state.data.server_config
        const queries = nextData?.props?.pageProps?.trpcState?.json?.queries;

        if (!queries || !Array.isArray(queries)) {
            return undefined;
        }

        // Find the query with server_config
        for (const query of queries) {
            const serverConfig = query?.state?.data?.server_config;

            if (serverConfig) {
                try {
                    // server_config is a JSON string
                    const config = typeof serverConfig === 'string' ? JSON.parse(serverConfig) : serverConfig;

                    // Extract first server from mcpServers object
                    if (config.mcpServers) {
                        const serverKey = Object.keys(config.mcpServers)[0];
                        if (serverKey) {
                            const serverData = config.mcpServers[serverKey];
                            return {
                                command: serverData.command,
                                args: serverData.args,
                                env: serverData.env
                            };
                        }
                    }
                } catch (e) {
                    // server_config parse failed, continue
                }
            }
        }
    } catch (e) {
        // JSON parse failed
    }

    return undefined;
}

export function extractDescription(html: string, fallback: string): string {
    const metaMatch = html.match(/<meta\s+name="description"\s+content="([^"]+)"/i);
    if (metaMatch && metaMatch[1]) return metaMatch[1].trim();
    const ogMatch = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i);
    if (ogMatch && ogMatch[1]) return ogMatch[1].trim();
    return fallback;
}

export function extractToolsFromJson(data: any): Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
}> | undefined {
    if (!data || !data.tools || !Array.isArray(data.tools)) return undefined;
    return data.tools.map((tool: any) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema || tool.input_schema,
    }));
}

export function extractAllToolsMetadata(html: string): Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
}> | undefined {
    // Tools are rarely in HTML - this is mostly for completeness
    return undefined;
}

/**
 * Extract ACTUAL remote SSE endpoint URLs ONLY
 * NOT catalog pages, NOT GitHub repos, NOT npm URLs
 */
export function extractRemoteServerUrl(html: string): string | undefined {
    const ssePatterns = [
        /https?:\/\/[a-z0-9.-]+\/sse\b/i,
        /https?:\/\/[a-z0-9.-]+\/mcp\b/i,
        /"url"\s*:\s*"(https?:\/\/[^"]+\.(?:vercel\.app|railway\.app|render\.com|fly\.io|replit\.app)[^"]*)"/i,
    ];
    for (const pattern of ssePatterns) {
        const match = html.match(pattern);
        if (match) {
            const url = match[1] || match[0];
            if (!url.includes('glama.ai') && !url.includes('mcp.so') && !url.includes('pulsemcp.com')) {
                return url;
            }
        }
    }
    return undefined;
}

/**
 * CRITICAL: Only mark as "http" if has ACTUAL SSE endpoint
 */
export function determineTransport(
    hasRemotes: boolean,
    remoteUrl?: string,
): "stdio" | "http" {
    if (hasRemotes || remoteUrl) return "http";
    return "stdio";
}

export function hasExistingDockerImage(
    packages?: Array<{ registryType: string; identifier: string }>,
    html?: string
): boolean {
    if (packages) {
        const hasDockerPkg = packages.some(p =>
            p.registryType === 'oci' || p.registryType === 'docker'
        );
        if (hasDockerPkg) return true;
    }
    if (html) {
        const hasDockerRef =
            html.toLowerCase().includes('docker.io/') ||
            html.toLowerCase().includes('ghcr.io/');
        if (hasDockerRef) return true;
    }
    return false;
}

export function isNpmOnly(
    packages?: Array<{ registryType: string; identifier: string }>,
    repositoryUrl?: string | null
): boolean {
    if (!packages || packages.length === 0) return false;
    if (repositoryUrl) return false;
    return packages.some(p =>
        p.registryType === 'npm' || p.registryType === 'npmjs'
    );
}

export function needsContainerization(server: {
    transport?: "stdio" | "http";
    remoteUrl?: string;
    repository?: { url?: string | null };
    packages?: Array<{ registryType: string; identifier: string }>;
    attributes?: string[];
}): boolean {
    if (server.transport === "http" || server.remoteUrl) return false;
    if (hasExistingDockerImage(server.packages)) return false;
    if (isNpmOnly(server.packages, server.repository?.url)) return false;
    return !!server.repository?.url;
}

/**
 * Package metadata with spawn configuration
 */
export interface PackageInfo {
    registryType: "npm" | "npmjs" | "oci" | "docker";
    identifier: string;
    version?: string;

    // Spawn configuration for runtime
    spawn?: {
        command?: string;
        args?: string[];
        env?: Record<string, string>;
    };

    // Display commands
    installCommand?: string;
    pullCommand?: string;
}

/**
 * Build NPM package metadata with spawn config
 */
export function buildNpmPackageInfo(identifier: string): PackageInfo {
    return {
        registryType: "npm",
        identifier,
        installCommand: `npx -y ${identifier}`,
        spawn: {
            command: "npx",
            args: ["-y", identifier]
        }
    };
}

/**
 * Build Docker/OCI package metadata with spawn config
 */
export function buildDockerPackageInfo(identifier: string): PackageInfo {
    return {
        registryType: "oci",
        identifier,
        pullCommand: `docker pull ${identifier}`,
        spawn: {
            command: "docker",
            args: ["run", "-i", "--rm", identifier]
        }
    };
}

/**
 * Tool metadata type
 */
export interface Tool {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
}

/**
 * Extract tools from Glama page by scraping Tools section
 * Tools are listed in right sidebar with links to /tools/[slug]
 */
export function extractToolsFromGlamaHtml(html: string): Tool[] | undefined {
    const tools: Tool[] = [];

    // Glama lists tools in a "Tools" section with links like /mcp/servers/@user/server/tools/tool-name
    // Pattern: <a href="/mcp/servers/[...]/tools/([^"]+)">
    const toolLinkRegex = /href="\/mcp\/servers\/[^"]+\/tools\/([^"]+)"/g;
    const toolLinks = [...html.matchAll(toolLinkRegex)];

    for (const match of toolLinks) {
        const toolSlug = match[1];

        // Convert slug to name (e.g., "get_a_joke" -> "get_a_joke")
        const toolName = toolSlug.replace(/-/g, '_');

        // Try to find description near the tool link
        // Usually in format: <a ...>toolName</a> <span>description</span>
        const contextStart = Math.max(0, match.index! - 200);
        const contextEnd = Math.min(html.length, match.index! + 200);
        const context = html.substring(contextStart, contextEnd);

        const descMatch = context.match(new RegExp(`${toolSlug}[^<]*<[^>]*>([^<]+)<`, 'i'));
        const description = descMatch ? descMatch[1].trim() : undefined;

        tools.push({
            name: toolName,
            description
        });
    }

    return tools.length > 0 ? tools : undefined;
}

/**
 * Extract tools from mcp.so __NEXT_DATA__ state
 * Tools metadata is embedded in Next.js page data
 */
export function extractToolsFromMcpSoHtml(html: string): Tool[] | undefined {
    const nextDataMatch = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([^<]+)<\/script>/);

    if (!nextDataMatch) {
        return undefined;
    }

    try {
        const nextData = JSON.parse(nextDataMatch[1]);
        const queries = nextData?.props?.pageProps?.trpcState?.json?.queries;

        if (!queries || !Array.isArray(queries)) {
            return undefined;
        }

        // Find tools in the query data
        for (const query of queries) {
            const tools = query?.state?.data?.tools;

            if (tools && Array.isArray(tools)) {
                return tools.map((tool: any) => ({
                    name: tool.name,
                    description: tool.description,
                    inputSchema: tool.inputSchema || tool.input_schema
                }));
            }
        }
    } catch (e) {
        // JSON parse failed
    }

    return undefined;
}

/**
 * Extract GitHub repository URL from Glama Resources section
 * This is ALWAYS present and more reliable than generic matching
 */
export function extractGitHubRepoFromGlamaResources(html: string): string | null {
    // Glama always has a "Resources" section with "GitHub Repository" link
    // Pattern: Resources section -> <a ...href="https://github.com/USER/REPO">GitHub Repository</a>

    // Look for GitHub Repository link in Resources section
    const resourcesMatch = html.match(/Resources[\s\S]{0,500}href="(https:\/\/github\.com\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+)"/i);
    if (resourcesMatch && resourcesMatch[1]) {
        return validateGitHubRepoUrl(resourcesMatch[1]);
    }

    // Fallback: Look for any "GitHub Repository" link
    const githubRepoMatch = html.match(/GitHub Repository[\s\S]{0,200}href="(https:\/\/github\.com\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+)"/i);
    if (githubRepoMatch && githubRepoMatch[1]) {
        return validateGitHubRepoUrl(githubRepoMatch[1]);
    }

    return null;
}

/**
 * Check if GitHub repo is from modelcontextprotocol origin
 * Used for pre-filtering duplicates from secondary sources
 * since we already get these from the official MCP Registry
 */
export function isFromRegistryOrigin(repoUrl: string): boolean {
    if (!repoUrl) return false;

    const normalized = repoUrl.toLowerCase();

    // Match ANY github.com URL that contains "modelcontextprotocol" in the org or repo path
    // This catches: 
    // - github.com/modelcontextprotocol/anything
    // - github.com/anything/modelcontextprotocol  
    // - github.com/orgs/modelcontextprotocol
    // - github.com/modelcontextprotocol-servers/anything
    return normalized.includes('github.com/modelcontextprotocol') ||
        normalized.includes('/modelcontextprotocol/') ||
        normalized.includes('/modelcontextprotocol-') ||
        normalized.includes('-modelcontextprotocol');
}

/**
 * Parse README sections from Glama to identify transport hints
 * Sections: Setup, Command, Configuration reveal transport type
 */
export function extractTransportHintsFromReadme(html: string): {
    hasNpmCommand: boolean;
    hasDockerCommand: boolean;
    hasRemoteUrl: boolean;
} {
    const hints = {
        hasNpmCommand: false,
        hasDockerCommand: false,
        hasRemoteUrl: false
    };

    // Look for npm/npx commands in Setup/Command sections
    if (html.match(/npx\s+(-y\s+)?[@a-z0-9/_-]+/i)) {
        hints.hasNpmCommand = true;
    }

    // Look for docker commands
    if (html.match(/docker\s+(run|pull|build)/i)) {
        hints.hasDockerCommand = true;
    }

    // Look for remote URL patterns in Configuration
    if (html.match(/https?:\/\/[a-z0-9.-]+\.(vercel\.app|railway\.app|render\.com|fly\.io|replit\.app)/i)) {
        hints.hasRemoteUrl = true;
    }

    return hints;
}
