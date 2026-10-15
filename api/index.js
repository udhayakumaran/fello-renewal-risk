// Vercel entry point: serves the CSM app. Compiled code lives in dist/ (npm run build).
import { buildApp } from "../dist/src/web/server.js";
import { webPool } from "../dist/src/db.js";

const app = buildApp(webPool(), process.env.SESSION_SECRET ?? "", process.env.DEMO_ACCESS_CODE ?? null);
export default app;
