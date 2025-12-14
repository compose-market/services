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
 *   pm2 restart services
 *   pm2 stop services
 *   pm2 logs services
 */
module.exports = {
    apps: [
        {
            name: "connector",
            script: "connector/dist/src/server.js",
            cwd: "/home/ubuntu/services",
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: "500M",
            env: {
                NODE_ENV: "production",
                PORT: 4001,
            },
            error_file: "/home/ubuntu/logs/connector-error.log",
            out_file: "/home/ubuntu/logs/connector-out.log",
            log_date_format: "YYYY-MM-DD HH:mm:ss Z",
        },
        {
            name: "sandbox",
            script: "sandbox/dist/src/server.js",
            cwd: "/home/ubuntu/services",
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: "500M",
            env: {
                NODE_ENV: "production",
                PORT: 4002,
            },
            error_file: "/home/ubuntu/logs/sandbox-error.log",
            out_file: "/home/ubuntu/logs/sandbox-out.log",
            log_date_format: "YYYY-MM-DD HH:mm:ss Z",
        },
        {
            name: "exporter",
            script: "exporter/dist/src/server.js",
            cwd: "/home/ubuntu/services",
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: "500M",
            env: {
                NODE_ENV: "production",
                PORT: 4003,
            },
            error_file: "/home/ubuntu/logs/exporter-error.log",
            out_file: "/home/ubuntu/logs/exporter-out.log",
            log_date_format: "YYYY-MM-DD HH:mm:ss Z",
        },
    ],

    // Deploy configuration is optional but useful for remote deploys
    deploy: {
        production: {
            user: "ubuntu",
            host: "services.compose.market",
            ref: "origin/main",
            repo: "git@github.com:your-repo/compose-market.git",
            path: "/home/ubuntu/services",
            "post-deploy":
                "npm install && npm run build && pm2 reload ecosystem.config.cjs --env production",
        },
    },
};
