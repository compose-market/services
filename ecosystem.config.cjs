/**
 * PM2 Ecosystem Configuration for Compose Services
 *
 * Manages all 3 services as a group:
 * - connector (port 4001)
 * - sandbox (port 4002)
 * - exporter (port 4003)
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs
 *   pm2 restart all
 *   pm2 stop all
 *   pm2 logs
 */
module.exports = {
    apps: [
        {
            name: "connector",
            script: "connector/dist/connector/src/server.js",
            cwd: "/home/ubuntu/services",
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: "500M",
            env: {
                NODE_ENV: "production",
            },
            error_file: "/home/ubuntu/logs/connector-error.log",
            out_file: "/home/ubuntu/logs/connector-out.log",
            log_date_format: "YYYY-MM-DD HH:mm:ss Z",
        },
        {
            name: "sandbox",
            script: "sandbox/dist/sandbox/src/server.js",
            cwd: "/home/ubuntu/services",
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: "500M",
            env: {
                NODE_ENV: "production",
            },
            error_file: "/home/ubuntu/logs/sandbox-error.log",
            out_file: "/home/ubuntu/logs/sandbox-out.log",
            log_date_format: "YYYY-MM-DD HH:mm:ss Z",
        },
        {
            name: "exporter",
            script: "exporter/dist/exporter/src/server.js",
            cwd: "/home/ubuntu/services",
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: "500M",
            env: {
                NODE_ENV: "production",
            },
            error_file: "/home/ubuntu/logs/exporter-error.log",
            out_file: "/home/ubuntu/logs/exporter-out.log",
            log_date_format: "YYYY-MM-DD HH:mm:ss Z",
        },
    ],
};
