import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
//
// IMPORTANT: if deploying to GitHub Pages as a project site (i.e. the URL
// is https://<username>.github.io/<repo-name>/ rather than a custom
// domain or a user/org root site), `base` MUST match the repo name below,
// or all the built asset paths (JS/CSS) will 404. Replace
// "funder-dashboard-standalone" with your actual GitHub repo name.
// If deploying to Vercel instead, delete the `base` line entirely --
// Vercel serves from the root and doesn't need this.
export default defineConfig({
  plugins: [react()],
  base: '/funder-dashboard-standalone/',
})
