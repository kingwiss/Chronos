import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // Load env file based on `mode` in the current directory.
  // The third argument '' ensures we load all env vars, including those not starting with VITE_
  const env = loadEnv(mode, '.', '');

  return {
    plugins: [react()],
    base: '/', // Vercel deploys to root by default
    build: {
      outDir: 'dist',
      sourcemap: false,
    },
    // Polyfill process.env for Gemini SDK and API keys compatibility
    define: {
      'process.env.API_KEY': JSON.stringify(env.API_KEY || env.VITE_API_KEY),
      'process.env.NODE_ENV': JSON.stringify(mode),
    },
    server: {
      port: 3000,
    }
  };
});