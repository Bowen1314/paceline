import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The frontend is fully self-contained: fonts, icons and both vendor
// libraries are bundled, nothing is fetched from another origin at runtime.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    // No data: URIs: every asset is a same-origin file, which keeps the CSP simple.
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 7000,
    rollupOptions: {
      output: {
        manualChunks(id: string): string | undefined {
          if (id.includes('node_modules/@bryntum')) return 'bryntum';
          if (id.includes('node_modules/ag-grid') || id.includes('node_modules/ag-charts')) return 'ag-grid';
          return undefined;
        },
      },
    },
  },
});
