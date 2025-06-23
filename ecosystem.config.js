module.exports = {
  apps: [
    {
      name: 'whatsapp-api',        // Nama aplikasi di PM2
      script: './index.js',        // Entry point file
      instances: 1,                // Atur ke "max" untuk cluster mode
      autorestart: true,
      watch: false,                // Ubah ke true kalau ingin auto-reload saat file berubah
      max_memory_restart: '300M',  // Restart kalau melebihi 300MB
      env: {
        NODE_ENV: 'development'
      },
      env_production: {
        NODE_ENV: 'production'
      }
    }
  ]
};
