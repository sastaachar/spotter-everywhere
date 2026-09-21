// Central, non-secret config for the extension. Credentials live in
// dev-credentials.js (gitignored). The ThoughtSpot host comes from
// ui/configs/thoughtspot-config.js via the SDK's initSpotter default.
export const config = {
  backendUrl: 'http://localhost:8799',
  backendApiKey: '',
};
