module.exports = {
  apps: [
    {
      name: "batbot-v11-hft",
      script: "./dist/index.js",
      instances: 1, // Single instance strictly required for SharedArrayBuffer zero-copy IPC
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      restart_delay: 3000,
      env: {
        NODE_ENV: "production",
        USE_TESTNET: "true",
        BINANCE_TESTNET: "true",
      },
      env_production: {
        NODE_ENV: "production",
        USE_TESTNET: "false",
        BINANCE_TESTNET: "false",
      },
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      out_file: "./logs/pm2-out.log",
      error_file: "./logs/pm2-error.log",
      merge_logs: true,
    },
  ],
};
