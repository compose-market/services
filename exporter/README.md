# Exporter Service

Generates downloadable workflow runner projects from Compose Market workflow definitions.

## Quick Start

```bash
# Install dependencies
npm install

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
| POST | `/export/workflow` | Export workflow as a zip file |

## Export Workflow

### Request: POST /export/workflow

```json
{
  "workflow": {
    "id": "my-workflow-id",
    "name": "My Workflow",
    "description": "Does something useful",
    "steps": [
      {
        "id": "step1",
        "name": "Get Twitter User",
        "type": "connectorTool",
        "connectorId": "x",
        "toolName": "get_user_info",
        "inputTemplate": {
          "username": "{{input.targetUser}}"
        },
        "saveAs": "steps.user_info"
      }
    ]
  },
  "projectName": "My Custom Bot",
  "description": "Custom integration for my use case",
  "author": "John Doe"
}
```

### Response

A `application/zip` file download containing:

```
my-custom-bot.zip
├── package.json          # Node.js project config
├── tsconfig.json         # TypeScript config
├── Dockerfile            # Docker build file
├── .env.example          # Environment template
├── README.md             # Usage instructions
└── src/
    ├── config.ts         # Environment config loader
    ├── types.ts          # TypeScript interfaces
    ├── template.ts       # Template resolution engine
    ├── workflowEngine.ts # Workflow orchestrator
    ├── workflowDefinition.ts  # Embedded workflow
    └── server.ts         # HTTP server
```

## Exported Project Usage

Once a user downloads and extracts the zip:

```bash
cd my-custom-bot
cp .env.example .env
# Edit .env to set CONNECTOR_BASE_URL

npm install
npm run build
npm start
```

The exported project exposes:
- `GET /health` - Health check with workflow info
- `POST /run` - Execute the workflow with `{ input: {...} }`

### Docker Deployment

```bash
docker build -t my-custom-bot .
docker run --env-file .env -p 8080:8080 my-custom-bot
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 4003 | HTTP port for this service |

## EC2 Deployment

### Prerequisites
- EC2 instance with Node.js 20+ installed
- SSH access configured (`ssh exporter`)

### Deploy

```bash
# From local machine
rsync -avz --exclude node_modules --exclude dist \
  backend/exporter/ exporter:~/exporter/

# On EC2
ssh exporter
cd ~/exporter
npm install
npm run build

# Start with PM2
pm2 start dist/server.js --name exporter
pm2 save
```

### Nginx Configuration

```nginx
server {
    listen 443 ssl;
    server_name exporter.compose.market;

    ssl_certificate /etc/letsencrypt/live/exporter.compose.market/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/exporter.compose.market/privkey.pem;

    location / {
        proxy_pass http://localhost:4003;
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
┌──────────────────────────────────────────────────────────┐
│                    Frontend (compose.tsx)                │
│                    "Export Workflow" button              │
└───────────────────────────┬──────────────────────────────┘
                            │ POST /export/workflow
                            ▼
┌──────────────────────────────────────────────────────────┐
│                  Exporter Service (:4003)                │
│                                                          │
│  ┌─────────────┐   ┌─────────────────┐   ┌───────────┐  │
│  │   Server    │──▶│ projectTemplate │──▶│  archiver │  │
│  │  (Express)  │   │   (reads from   │   │   (zip)   │  │
│  └─────────────┘   │   runner/ dir)  │   └─────┬─────┘  │
│                    └─────────────────┘         │        │
└────────────────────────────────────────────────┼────────┘
                                                 │
                                                 ▼
                                        application/zip
                                           download
```

The exported project then runs independently:

```
┌──────────────────────────────────────────────────────────┐
│            Exported Project (buyer's infra)              │
│                                                          │
│  POST /run { input: {...} }                              │
│       │                                                  │
│       ▼                                                  │
│  ┌─────────────────────────────────────────────────────┐│
│  │  workflowEngine.ts                                  ││
│  │  - Reads WORKFLOW from workflowDefinition.ts       ││
│  │  - Resolves templates                              ││
│  │  - Calls Connector Hub                             ││
│  └──────────────────────────┬──────────────────────────┘│
└─────────────────────────────┼───────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────┐
│        Connector Hub (compose.market or self-hosted)     │
└──────────────────────────────────────────────────────────┘
```

