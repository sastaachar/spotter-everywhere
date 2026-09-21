import { createApp } from './app';

const DEFAULT_PORT = 8787;

const apiKey = Bun.env.SPOTTER_API_KEY;
if (!apiKey) {
  console.error('SPOTTER_API_KEY is not set; refusing to start without an API key.');
  process.exit(1);
}

const port = Number(Bun.env.PORT ?? DEFAULT_PORT);

const { THOUGHTSPOT_HOST, THOUGHTSPOT_USERNAME, THOUGHTSPOT_PASSWORD } = Bun.env;
const thoughtSpot =
  THOUGHTSPOT_HOST && THOUGHTSPOT_USERNAME && THOUGHTSPOT_PASSWORD
    ? { host: THOUGHTSPOT_HOST, username: THOUGHTSPOT_USERNAME, password: THOUGHTSPOT_PASSWORD }
    : undefined;
if (!thoughtSpot) console.warn('ThoughtSpot credentials not set; GET /token will return 503.');

const app = createApp({ apiKey, thoughtSpot });

export default { port, fetch: app.fetch };

console.log(`spotter backend listening on http://localhost:${port}`);
