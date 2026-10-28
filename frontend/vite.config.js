import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = {
  target: 'http://127.0.0.1:8000',
  changeOrigin: false,
};

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': api } },
  preview: { proxy: { '/api': api } },
});
