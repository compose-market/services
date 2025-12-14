import "dotenv/config";

export const PORT = parseInt(process.env.PORT || "8080", 10);
export const CONNECTOR_BASE_URL =
  process.env.CONNECTOR_BASE_URL || "http://localhost:4001";
export const CONNECTOR_TIMEOUT_MS = parseInt(
  process.env.CONNECTOR_TIMEOUT_MS || "60000",
  10
);

