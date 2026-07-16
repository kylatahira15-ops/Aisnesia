// PM2 Ecosystem Config — AISNESIA
// Optimized for Windows Server, 1500+ ships
// Usage: pm2 start ecosystem.config.js --env production

module.exports = {
  apps: [
    {
      name        : 'aisnesia',
      script      : 'server.js',
      instances   : 1,           // Node.js single-threaded; 1 instance is optimal
                                 // Jika CPU > 8 core dan multiple clients: ganti ke 2-4
      autorestart : true,
      watch       : false,
      max_memory_restart: '1G',  // restart jika RAM > 1 GB

      // ── Node.js flags untuk high-throughput ──────────────
      node_args: [
        '--max-old-space-size=2048',    // 2 GB heap untuk 1500 kapal + history
        '--max-semi-space-size=64',     // Larger young gen = fewer minor GCs
        '--optimize-for-size',          // Prefer memory efficiency over raw speed
        // Uncomment untuk production profiling:
        // '--expose-gc',               // Expose manual GC trigger
      ].join(' '),

      env: {
        NODE_ENV  : 'development',
        PORT      : 4000,
      },
      env_production: {
        NODE_ENV  : 'production',
        PORT      : 4000,
        BATCH_MS  : 150,         // Batch window 150ms
        LOG_LEVEL : 'info',
      },

      // Log config
      out_file        : './logs/out.log',
      error_file      : './logs/err.log',
      log_date_format : 'YYYY-MM-DD HH:mm:ss',
      merge_logs      : true,
      log_type        : 'json',

      // Windows-specific: tidak perlu cluster_mode
      exec_mode       : 'fork',
    },
  ],
};
