import type { Hono } from 'hono';
import { ensureUser, mintUserToken, addUserToGroups, sanitizeUsername } from '../thoughtspot';
import type { Deps } from '../deps';

export function registerProvisioningRoutes(app: Hono, deps: Deps): void {
  const { options, canAdmin, adminEnv } = deps;

  // Idempotently provision a ThoughtSpot user for a platform identity, using
  // the server-held tsadmin token. The client never sees a TS token. Body:
  // JSON { userid, platform, email? }. Returns the (existing or created) user.
  app.post('/provision', async (c) => {
    if (!canAdmin()) {
      return c.json({ error: 'not_configured', detail: 'TS_HOST and TS_TOKEN must be set to provision users' }, 503);
    }
    let body: Record<string, string>;
    try {
      body = (await c.req.json()) as Record<string, string>;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const userid = (body.userid ?? '').trim();
    const platform = (body.platform ?? '').trim();
    if (!userid || !platform) return c.json({ error: 'invalid_request', detail: 'userid and platform are required' }, 400);

    const env = (await adminEnv())!;
    const user = await ensureUser(
      env,
      {
        userid, platform, prefix: options.tsUserPrefix, accountType: options.tsAccountType,
        emailDomain: options.tsEmailDomain, email: body.email, groups: options.tsUserGroups,
      },
    );
    return c.json({ userid, platform, user }, user.created ? 201 : 200);
  });

  // Mint a cookieless login token FOR the provisioned user (not the admin), so
  // the embed runs as them. Uses the trusted-auth secret key held server-side.
  // Body: JSON { userid, platform }. 503 if no secret key is configured (the
  // extension then falls back to the admin embed).
  app.post('/embed-token', async (c) => {
    if (!options.tsHost) return c.json({ error: 'not_configured', detail: 'TS_HOST not set' }, 503);
    if (!options.tsSecretKey) {
      return c.json({ error: 'not_configured', detail: 'TS_SECRET_KEY not set — enable trusted auth and set its secret key' }, 503);
    }
    let body: Record<string, string>;
    try {
      body = (await c.req.json()) as Record<string, string>;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const userid = (body.userid ?? '').trim();
    const platform = (body.platform ?? 'tableau').trim();
    if (!userid) return c.json({ error: 'invalid_request', detail: 'userid is required' }, 400);
    const username = sanitizeUsername(`${options.tsUserPrefix ?? ''}${userid}`);
    const email = `${username}@${options.tsEmailDomain ?? 'thoughtspot.com'}`;
    try {
      // JIT: create the user (if absent) with the privileged groups AND mint the
      // token, in one call — provisioning happens at embed time.
      const token = await mintUserToken(options.tsHost, username, options.tsSecretKey, {
        autoCreate: true,
        groups: options.tsUserGroups,
        email,
        displayName: `${userid} (${platform})`,
      });
      // auto_create only assigns groups to NEW users; ensure membership for
      // existing users too (idempotent ADD) so they keep the Spotter privilege.
      if (options.tsUserGroups?.length) {
        try {
          const env = await adminEnv();
          if (env) await addUserToGroups(env, username, options.tsUserGroups);
        } catch (e) {
          console.error(`ensure groups for ${username} failed:`, (e as Error).message);
        }
      }
      return c.json({ token, username, host: options.tsHost });
    } catch (e) {
      return c.json({ error: 'token_failed', detail: (e as Error).message }, 502);
    }
  });
}
