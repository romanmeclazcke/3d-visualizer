import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  define: {
    "process.env.NEXT_PUBLIC_ASSETS_CDN_URL": JSON.stringify("https://editor.pascal.app"),
  },
});
