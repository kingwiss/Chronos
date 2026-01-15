import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // Load env file based on `mode` in the current directory.
  const env = loadEnv(mode, '.', '');

  return {
    plugins: [react()],
    base: './', // Important for GitHub Pages to load assets correctly
    build: {
      outDir: 'dist',
      sourcemap: false,
    },
    // Polyfill process.env for Gemini SDK and API keys
    define: {
      'process.env.API_KEY': JSON.stringify(env.API_KEY),
      'process.env': JSON.stringify(env)
    },
    server: {
      port: 3000,
    }
  };
});