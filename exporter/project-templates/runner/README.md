# __PROJECT_NAME__

__DESCRIPTION__

## What is this?

This is a self-contained Node.js + TypeScript service that runs
a pre-defined agentic workflow exported from Compose Market.

- The workflow is embedded in `src/workflowDefinition.ts`
- The orchestration engine is in `src/workflowEngine.ts`
- It talks to a Connector Hub via `CONNECTOR_BASE_URL`

## Quick start

```bash
cp .env.example .env
# edit .env to point CONNECTOR_BASE_URL to your connector-hub

npm install
npm run build
npm start
```

The service will listen on `PORT` (default 8080).

## API

### `POST /run`

Execute the workflow with an arbitrary JSON input.

Request body:

```json
{
  "input": {
    "any": "json",
    "you": "want"
  }
}
```

Response body:

```json
{
  "workflowId": "__WORKFLOW_ID__",
  "success": true,
  "context": { /* final context */ },
  "logs": [ /* per-step logs */ ]
}
```

### `GET /health`

Basic health check:

```json
{
  "status": "ok",
  "service": "exported-workflow",
  "workflowId": "__WORKFLOW_ID__",
  "timestamp": "..."
}
```

## Docker

```bash
docker build -t __PROJECT_NAME__ .
docker run --env-file .env -p 8080:8080 __PROJECT_NAME__
```

Make sure `CONNECTOR_BASE_URL` is reachable from inside the container.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 8080 | HTTP port |
| `CONNECTOR_BASE_URL` | http://localhost:4001 | Connector Hub URL |
| `CONNECTOR_TIMEOUT_MS` | 60000 | Timeout for connector calls (ms) |

## License

This workflow was exported from [Compose Market](https://compose.market).

