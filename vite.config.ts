import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const port = Number(env.APP_PORT || '3000');
  const apiPort = Number(env.API_PORT || '8787');

  return {
    plugins: [react()],
    server: {
      host: '0.0.0.0',
      port,
      proxy: {
        '/api': {
          target: `http://localhost:${apiPort}`,
          changeOrigin: true
        }
      }
    }
  };
});
