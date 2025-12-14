# Sandbox Service

Workflow orchestrator for Compose Market. Executes multi-step workflows by calling the Connector Hub for each step.

## Quick Start

```bash
# Install dependencies
npm install

# Configure environment
export CONNECTOR_BASE_URL=http://localhost:4001  # or https://connector.compose.market

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
| POST | `/sandbox/run` | Execute a workflow |
| POST | `/sandbox/validate` | Validate a workflow without executing |
| GET | `/sandbox/connectors` | List connectors (proxied from Connector Hub) |
| GET | `/sandbox/connectors/:id/tools` | List tools for a connector (proxied) |

## Workflow Execution

### Request: POST /sandbox/run

```json
{
  "workflow": {
    "id": "my-workflow",
    "name": "My First Workflow",
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
  "input": {
    "targetUser": "elonmusk"
  }
}
```

### Response

```json
{
  "workflowId": "my-workflow",
  "success": true,
  "context": {
    "input": { "targetUser": "elonmusk" },
    "steps.user_info": { ... }
  },
  "logs": [
    {
      "stepId": "step1",
      "name": "Get Twitter User",
      "connectorId": "x",
      "toolName": "get_user_info",
      "startedAt": "2025-12-01T12:00:00.000Z",
      "finishedAt": "2025-12-01T12:00:01.000Z",
      "status": "success",
      "args": { "username": "elonmusk" },
      "output": { ... }
    }
  ]
}
```

## Template Syntax

Use `{{path.to.value}}` to reference values from context:

- `{{input.xxx}}` - Initial input values
- `{{steps.step_id.raw.xxx}}` - Output from a previous step
- Supports nested paths: `{{steps.user.raw.data.public_metrics.followers_count}}`

## Multi-Step Workflow Example

```json
{
  "workflow": {
    "id": "twitter-analysis",
    "name": "Twitter User Analysis",
    "steps": [
      {
        "id": "get_user",
        "name": "Fetch user profile",
        "type": "connectorTool",
        "connectorId": "x",
        "toolName": "get_user_info",
        "inputTemplate": { "username": "{{input.username}}" },
        "saveAs": "steps.user"
      },
      {
        "id": "get_timeline",
        "name": "Fetch recent tweets",
        "type": "connectorTool",
        "connectorId": "x",
        "toolName": "get_user_timeline",
        "inputTemplate": { 
          "username": "{{input.username}}",
          "max_results": 10
        },
        "saveAs": "steps.timeline"
      }
    ]
  },
  "input": {
    "username": "naval"
  }
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 4002 | HTTP port |
| `CONNECTOR_BASE_URL` | http://localhost:4001 | Connector Hub URL |
| `CONNECTOR_TIMEOUT_MS` | 60000 | Timeout for connector calls |
| `MAX_WORKFLOW_STEPS` | 50 | Maximum steps per workflow |

## EC2 Deployment

### Prerequisites
- EC2 instance with Node.js 22+ installed
- SSH access configured (`ssh sandbox`)

### Deploy

```bash
# From local machine
rsync -avz --exclude node_modules --exclude dist \
  backend/sandbox/ sandbox:~/sandbox/

# On EC2
ssh sandbox
cd ~/sandbox
npm install
npm run build

# Start with PM2
pm2 start dist/server.js --name sandbox
pm2 save
```

### Nginx Configuration

```nginx
server {
    listen 443 ssl;
    server_name sandbox.compose.market;

    ssl_certificate /etc/letsencrypt/live/sandbox.compose.market/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/sandbox.compose.market/privkey.pem;

    location / {
        proxy_pass http://localhost:4002;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }
}
```

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    Frontend (compose.tsx)                │
└───────────────────────────┬──────────────────────────────┘
                            │ POST /sandbox/run
                            ▼
┌──────────────────────────────────────────────────────────┐
│                   Sandbox Service (:4002)                │
│                                                          │
│  ┌─────────────┐   ┌─────────────┐   ┌──────────────┐  │
│  │   Server    │──▶│  Workflow   │──▶│   Template   │  │
│  │  (Express)  │   │   Engine    │   │    Engine    │  │
│  └─────────────┘   └──────┬──────┘   └──────────────┘  │
│                           │                             │
└───────────────────────────┼─────────────────────────────┘
                            │ POST /connectors/:id/call
                            ▼
┌──────────────────────────────────────────────────────────┐
│                 Connector Hub (:4001)                    │
│                                                          │
│   ┌───────┐  ┌────────┐  ┌────────┐  ┌─────────┐       │
│   │   X   │  │ Notion │  │ Google │  │ Discord │       │
│   └───────┘  └────────┘  └────────┘  └─────────┘       │
└──────────────────────────────────────────────────────────┘
```

