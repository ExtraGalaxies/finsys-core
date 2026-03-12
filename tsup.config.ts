import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  // Copy static assets (JSON schemas + data files) after build
  onSuccess: [
    'mkdir -p dist/schema dist/data',
    'cp src/schema/unified-form.schema.json dist/schema/unified-form.schema.json',
    'cp -r src/data/* dist/data/',
  ].join(' && '),
});
