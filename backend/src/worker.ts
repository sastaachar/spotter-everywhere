// Cloudflare Workers entry. Same Hono app as the Bun entry (src/index.ts),
// but env comes from the fetch handler, not Bun.env. Deploy with `wrangler deploy`.
import { createApp } from './app';

interface WorkerEnv {
  SPOTTER_API_KEY?: string;
  TS_HOST?: string;
  TS_TOKEN?: string;
  TS_USER_PREFIX?: string;
  TS_ACCOUNT_TYPE?: string;
  TS_EMAIL_DOMAIN?: string;
  TS_SECRET_KEY?: string;
  TS_USER_GROUPS?: string;
  ALLOWED_ORIGINS?: string;
}

let app: ReturnType<typeof createApp> | undefined;

export default {
  fetch(req: Request, env: WorkerEnv, ctx: unknown): Response | Promise<Response> {
    if (!env.SPOTTER_API_KEY) {
      return new Response(JSON.stringify({ error: 'SPOTTER_API_KEY not configured' }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      });
    }
    app ??= createApp({
      apiKey: env.SPOTTER_API_KEY,
      tsHost: env.TS_HOST,
      tsToken: env.TS_TOKEN,
      tsUserPrefix: env.TS_USER_PREFIX,
      tsAccountType: env.TS_ACCOUNT_TYPE,
      tsEmailDomain: env.TS_EMAIL_DOMAIN,
      tsSecretKey: env.TS_SECRET_KEY,
      tsUserGroups: env.TS_USER_GROUPS?.split(',').map((s) => s.trim()).filter(Boolean),
      allowedOrigins: env.ALLOWED_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean),
    });
    return app.fetch(req, env as Record<string, unknown>, ctx as never);
  },
};
