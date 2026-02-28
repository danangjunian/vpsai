module.exports = {
  apps: [
    {
      name: "wa-bot-clean",
      script: "src/index.js",
      cwd: "/opt/wa-bot-clean-v1",
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};
