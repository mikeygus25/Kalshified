module.exports = {
  apps: [{
    name:          "kalshi-agents",
    script:        "index.js",
    watch:         false,
    restart_delay: 5000,
    max_restarts:  20,
    min_uptime:    "10s",
    log_date_format: "YYYY-MM-DD HH:mm:ss",
    error_file:    "logs/pm2-error.log",
    out_file:      "logs/pm2-out.log",
    merge_logs:    true,
  }],
};
