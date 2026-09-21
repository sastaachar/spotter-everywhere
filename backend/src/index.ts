import { createApp } from './app';

const DEFAULT_PORT = 8787;

const apiKey = Bun.env.SPOTTER_API_KEY;
if (!apiKey) {
  console.error('SPOTTER_API_KEY is not set; refusing to start without an API key.');
  process.exit(1);
}

const port = Number(Bun.env.PORT ?? DEFAULT_PORT);
const app = createApp({
  apiKey,
  tsHost: Bun.env.TS_HOST,
  tsToken: Bun.env.TS_TOKEN,
  tsUserPrefix: Bun.env.TS_USER_PREFIX,
  tsAccountType: Bun.env.TS_ACCOUNT_TYPE,
});

export default { port, fetch: app.fetch };

console.log(`spotter backend listening on http://localhost:${port}`);
