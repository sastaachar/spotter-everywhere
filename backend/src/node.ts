// Node runtime entry (same Hono app as the Bun/Workers entries).
//
// Use this when the target ThoughtSpot cluster has a SELF-SIGNED cert:
// Cloudflare's `workerd` cannot be given a custom CA for outbound fetch, so it
// can't call such a cluster. Node can — trust the cluster's cert via the
// NODE_EXTRA_CA_CERTS env var (full verification stays on; no code disables TLS):
//
//   NODE_EXTRA_CA_CERTS=./cluster-ca.pem npm run node:dev
//
// For a CA-signed cluster (e.g. ThoughtSpot Cloud), the Workers entry
// (worker.ts) works too and NODE_EXTRA_CA_CERTS isn't needed here.
import { checkServerIdentity } from 'node:tls';
import { Agent, setGlobalDispatcher } from 'undici';
import { serve } from '@hono/node-server';
import { createApp } from './app';

const apiKey = process.env.SPOTTER_API_KEY;
if (!apiKey) {
  console.error('SPOTTER_API_KEY is not set; refusing to start without an API key.');
  process.exit(1);
}

// Self-signed internal clusters often present a cert with no matching CN/SAN for
// the IP you connect by. With the cert pinned via NODE_EXTRA_CA_CERTS the
// SIGNATURE still verifies (rejectUnauthorized stays on); only the hostname
// match fails. When TS_TLS_SKIP_HOSTNAME=true, skip that hostname check for the
// configured cluster host ONLY — every other host keeps the default check. This
// is the org-endorsed pin-and-relax-hostname pattern, not a blanket TLS bypass.
if (process.env.TS_TLS_SKIP_HOSTNAME === 'true' && process.env.TS_HOST) {
  const pinnedHost = new URL(process.env.TS_HOST).hostname;
  setGlobalDispatcher(new Agent({
    connect: {
      checkServerIdentity: (host, cert) =>
        host === pinnedHost ? undefined : checkServerIdentity(host, cert),
    },
  }));
  console.log(`TLS: hostname check skipped for pinned cluster host ${pinnedHost} (cert still verified via NODE_EXTRA_CA_CERTS)`);
}

const port = Number(process.env.PORT ?? 8799);
const app = createApp({
  apiKey,
  tsHost: process.env.TS_HOST,
  tsToken: process.env.TS_TOKEN,
  tsUserPrefix: process.env.TS_USER_PREFIX,
  tsAccountType: process.env.TS_ACCOUNT_TYPE,
  tsEmailDomain: process.env.TS_EMAIL_DOMAIN,
});

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`spotter backend (node) listening on http://localhost:${info.port}`);
});
