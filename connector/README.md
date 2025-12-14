# Connector Hub

MCP-based connector service for Compose Market. Provides unified access to external services (X, Notion, Google Workspace, Discord) via HTTP API.

## Quick Start

```bash
# Install dependencies
npm install

# Copy and configure environment variables
cp .env.example .env
# Edit .env with your credentials

# Run in development mode
npm run dev

# Build for production
npm run build
npm start
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/connectors` | List all connectors with availability status |
| GET | `/connectors/:id` | Get details for a specific connector |
| GET | `/connectors/:id/tools` | List available tools for a connector |
| POST | `/connectors/:id/call` | Execute a tool on a connector |

### Example: List Connectors

```bash
curl http://localhost:4001/connectors
```

### Example: List X Tools

```bash
curl http://localhost:4001/connectors/x/tools
```

### Example: Post a Tweet

```bash
curl -X POST http://localhost:4001/connectors/x/call \
  -H "Content-Type: application/json" \
  -d '{
    "toolName": "post_tweet",
    "args": { "text": "Hello from Connector Hub!" }
  }'
```

## Connectors

### X (Twitter)
HTTP-based connector using X API v2. Credentials required:
- `X_API_KEY`
- `X_API_KEY_SECRET`
- `X_ACCESS_TOKEN`
- `X_ACCESS_TOKEN_SECRET`
- `X_BEARER_TOKEN`

Available tools:
- `post_tweet` - Post a new tweet
- `get_user_timeline` - Get tweets from a user
- `search_tweets` - Search for tweets
- `get_user_info` - Get user profile info

### Notion
MCP-based connector using `@notionhq/notion-mcp-server`. Credentials required:
- `NOTION_API_KEY`

### Google Workspace
MCP-based connector. Credentials required:
- `GOOGLE_CREDENTIALS_JSON`
- `GOOGLE_SUBJECT_EMAIL`

### Discord
MCP-based connector. Credentials required:
- `DISCORD_BOT_TOKEN`

## EC2 Deployment

### Prerequisites
- EC2 instance with Node.js 22+ installed
- SSH access configured (`ssh connector`)

### Deploy

```bash
# From local machine
rsync -avz --exclude node_modules --exclude dist \
  backend/connector/ connector:~/connector/

# On EC2
ssh connector
cd ~/connector
npm install
npm run build

# Start with PM2
pm2 start dist/server.js --name connector-hub
pm2 save
```

### MCP Server Installation (on EC2)

For MCP-based connectors (Notion, Google, Discord), install the servers:

```bash
# Create MCP directory
sudo mkdir -p /opt/mcp

# Notion (installed via npx, no setup needed)

# Google Workspace
cd /opt/mcp
git clone https://github.com/taylorwilsdon/google_workspace_mcp.git
cd google_workspace_mcp
npm install && npm run build

# Discord
cd /opt/mcp
git clone https://github.com/your-discord-mcp-server.git discord-mcp
cd discord-mcp
npm install && npm run build
```

### Nginx Configuration

```nginx
server {
    listen 443 ssl;
    server_name connector.compose.market;

    ssl_certificate /etc/letsencrypt/live/connector.compose.market/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/connector.compose.market/privkey.pem;

    location / {
        proxy_pass http://localhost:4001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Connector Hub                           │
│                                                             │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    │
│  │  HTTP API   │───▶│  MCP Client │───▶│ MCP Servers │    │
│  │  (Express)  │    │   Wrapper   │    │ (stdio)     │    │
│  └─────────────┘    └─────────────┘    └─────────────┘    │
│         │                                                   │
│         │           ┌─────────────┐                        │
│         └──────────▶│ HTTP-based  │ (for X, etc.)         │
│                     │ Connectors  │                        │
│                     └─────────────┘                        │
└─────────────────────────────────────────────────────────────┘
```

## Environment Variables

See `.env.example` for all available configuration options.

