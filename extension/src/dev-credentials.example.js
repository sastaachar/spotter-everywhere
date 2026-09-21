// Copy to dev-credentials.js (gitignored) and fill in. Used when the options page is empty.
export const devCredentials = {
  username: '',
  password: '',
  // Must match the backend's SPOTTER_API_KEY (backend/.dev.vars), or the
  // extension's /dataset and /dataset/check calls return 401 unauthorized.
  backendApiKey: '',
};
