import { defineConfig } from "vite";

import { gui } from "@opencode/plugin/gui/vite";

// Builds the plugin's ./gui-experimental bundle for OpenCode Desktop: one
// CommonJS file at dist/gui-experimental.cjs from the src/gui.tsx entry (the
// preset's defaults). App-shared modules (solid-js, @opencode/*, effect) stay
// external; everything the bundle needs is inlined, dynamic imports included.
export default defineConfig({ plugins: [gui()] });
