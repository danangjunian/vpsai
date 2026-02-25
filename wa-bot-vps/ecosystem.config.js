module.exports = {
  apps: [
    {
      name: "wa-bot",
      script: "src/index.js",
      cwd: "/opt/wa-bot",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      min_uptime: "30s",
      restart_delay: 5000,
      exp_backoff_restart_delay: 200,
      max_memory_restart: "300M",
      time: true,
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};
