import { defineConfig } from 'vite';

// Only the GitHub Pages deploy build needs a non-root base. Local dev/build stay at '/' unless
// overridden.
export default defineConfig({
  base: process.env.DEPLOY_BASE ?? '/',
});
