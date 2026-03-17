import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Custom plugin to integrate Express API server into Vite dev server
function apiServerPlugin() {
  return {
    name: 'api-server',
    configureServer: async (server) => {
      // Dynamically import the API setup
      const { setupApi } = await import('./api.js');
      setupApi(server.middlewares);
    }
  };
}

export default defineConfig({
  plugins: [react(), apiServerPlugin()],
  server: {
    port: 5000,
    host: '0.0.0.0',
    allowedHosts: true
  }
});
