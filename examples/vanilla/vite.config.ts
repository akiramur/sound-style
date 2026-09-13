import { defineConfig } from 'vite';

// Only the GitHub Pages deploy build needs a non-root base (served at
// https://akiramur.github.io/sound-style/). Local dev/build stay at '/' unless overridden.
export default defineConfig({
  base: process.env.DEPLOY_BASE ?? '/',
});
