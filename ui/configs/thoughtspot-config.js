// Dev cluster for now; the extension options page should override this later.
// Must be the same cluster the backend loads data into (backend/.dev.vars
// TS_HOST) — the worksheet ids Spotter is pointed at only exist there.
export const thoughtSpotConfig = {
  host: 'https://172.32.111.47:8443',
};
