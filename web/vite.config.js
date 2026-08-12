import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// server/parse.mjs 를 브라우저에서 그대로 import 한다 (스펙 이중구현 방지)
export default defineConfig({
  plugins: [react()],
  server: {
    fs: { allow: ['..'] },
    proxy: { '/api': 'http://localhost:4680' },
  },
})
