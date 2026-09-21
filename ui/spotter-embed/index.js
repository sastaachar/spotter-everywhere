import { SpotterEmbed, LiveboardEmbed, init, AuthType } from '@thoughtspot/visual-embed-sdk';
import { tableauConfig } from '../configs/tableau-config.js';
import { powerBiConfig } from '../configs/power-bi-config.js';
import { thoughtSpotConfig } from '../configs/thoughtspot-config.js';

/**
 * @typedef {Object} PlatformColors
 * @property {string} primary
 * @property {string} primaryHover
 * @property {string} primaryActive
 * @property {string} secondary
 * @property {string} secondaryHover
 * @property {string} background
 * @property {string} surface
 * @property {string} text
 * @property {string} textSecondary
 * @property {string} font
 *
 * @typedef {Object} PlatformConfig
 * @property {string} platform
 * @property {string} label
 * @property {PlatformColors} colors
 * @property {Record<string, string>} [cssVariables] raw --ts-var overrides; win over colors
 * @property {import('@thoughtspot/visual-embed-sdk').SpotterEmbedViewConfig} [viewConfig]
 */

const WHITE = '#ffffff';

/** @param {PlatformConfig} config */
export function cssVariablesFor(config) {
  const c = config.colors;
  return {
    '--ts-var-root-background': c.background,
    '--ts-var-root-color': c.text,
    '--ts-var-root-secondary-color': c.textSecondary,
    '--ts-var-root-font-family': c.font,
    '--ts-var-nav-background': c.surface,
    '--ts-var-nav-color': c.text,
    '--ts-var-button--primary-background': c.primary,
    '--ts-var-button--primary--hover-background': c.primaryHover,
    '--ts-var-button--primary--active-background': c.primaryActive,
    '--ts-var-button--primary-color': WHITE,
    '--ts-var-button--secondary-background': c.secondary,
    '--ts-var-button--secondary--hover-background': c.secondaryHover,
    '--ts-var-button--secondary--active-background': c.secondaryHover,
    '--ts-var-button--secondary-color': c.text,
    '--ts-var-spotter-prompt-background': c.surface,
    '--ts-var-spotter-input-background': c.background,
    ...(config.cssVariables || {}),
  };
}

/**
 * @param {PlatformConfig} config
 * @param {import('@thoughtspot/visual-embed-sdk').CustomisationsInterface} [extra]
 */
export function customizationsFor(config, extra = {}) {
  const style = extra.style || {};
  const customCSS = style.customCSS || {};
  return {
    ...extra,
    style: {
      ...style,
      customCSS: { ...customCSS, variables: { ...cssVariablesFor(config), ...(customCSS.variables || {}) } },
    },
  };
}

/**
 * @param {PlatformConfig} config
 * @param {import('@thoughtspot/visual-embed-sdk').SpotterEmbedViewConfig} [viewConfig]
 */
export function viewConfigFor(config, viewConfig = {}) {
  return { ...config.viewConfig, ...viewConfig, customizations: customizationsFor(config, viewConfig.customizations) };
}

const TOKEN_PATH = '/api/rest/2.0/auth/token/full';
const TOKEN_VALIDITY_SECONDS = 300;

/**
 * Dev-only: exchange a username and password for a cookieless token straight
 * from the browser. Production must move this behind a backend.
 * @param {{ host?: string, username: string, password: string, fetchImpl?: typeof fetch }} creds
 * @returns {Promise<string>}
 */
export async function mintToken({ host = thoughtSpotConfig.host, username, password, fetchImpl = fetch }) {
  const url = new URL(TOKEN_PATH, host);
  if (url.protocol !== 'https:') throw new Error('ThoughtSpot host must be https');
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ username, password, validity_time_in_sec: TOKEN_VALIDITY_SECONDS }),
  });
  if (!res.ok) throw new Error('ThoughtSpot token request failed with status ' + res.status);
  const body = await res.json();
  if (!body || typeof body.token !== 'string') throw new Error('ThoughtSpot token response had no token');
  return body.token;
}

/**
 * init() pinned to cookieless trusted auth. Pass getAuthToken, or for dev pass
 * username and password and the token is minted from the browser.
 * thoughtSpotHost defaults to the configured cluster.
 * @param {Omit<import('@thoughtspot/visual-embed-sdk').EmbedConfig, 'authType' | 'thoughtSpotHost' | 'getAuthToken'> & { thoughtSpotHost?: string, getAuthToken?: () => Promise<string>, username?: string, password?: string }} config
 */
export function initSpotter({ username, password, ...config }) {
  const thoughtSpotHost = config.thoughtSpotHost || thoughtSpotConfig.host;
  const getAuthToken = config.getAuthToken || (username && password ? () => mintToken({ host: thoughtSpotHost, username, password }) : undefined);
  if (!getAuthToken) throw new Error('initSpotter needs getAuthToken, or username and password');
  // In a chrome-extension panel the SDK derives hostAppUrl from location.host,
  // which is the bare extension id (no scheme) — an invalid URL. Force a proper
  // one via additionalFlags. Caller can override.
  const origin = (typeof location !== 'undefined' && location.origin) || thoughtSpotHost;
  const additionalFlags = { hostAppUrl: origin, ...(config.additionalFlags || {}) };
  return init({ ...config, thoughtSpotHost, getAuthToken, additionalFlags, authType: AuthType.TrustedAuthTokenCookieless });
}

export class PlatformSpotterEmbed extends SpotterEmbed {
  /**
   * @param {import('@thoughtspot/visual-embed-sdk').DOMSelector} domSelector
   * @param {PlatformConfig} config
   * @param {import('@thoughtspot/visual-embed-sdk').SpotterEmbedViewConfig} [viewConfig]
   */
  constructor(domSelector, config, viewConfig) {
    super(domSelector, viewConfigFor(config, viewConfig));
    this.platform = config.platform;
    this.platformLabel = config.label;
  }
}

export class TableauSpotterEmbed extends PlatformSpotterEmbed {
  constructor(domSelector, viewConfig) {
    super(domSelector, tableauConfig, viewConfig);
  }
}

export class PowerBiSpotterEmbed extends PlatformSpotterEmbed {
  constructor(domSelector, viewConfig) {
    super(domSelector, powerBiConfig, viewConfig);
  }
}

// Themed Liveboard embed — same platform config/theme as the Spotter embeds,
// but renders a ThoughtSpot Liveboard (viewConfig takes `liveboardId`).
export class PlatformLiveboardEmbed extends LiveboardEmbed {
  constructor(domSelector, config, viewConfig) {
    super(domSelector, viewConfigFor(config, viewConfig));
    this.platform = config.platform;
    this.platformLabel = config.label;
  }
}

export class TableauLiveboardEmbed extends PlatformLiveboardEmbed {
  constructor(domSelector, viewConfig) {
    super(domSelector, tableauConfig, viewConfig);
  }
}

export class PowerBiLiveboardEmbed extends PlatformLiveboardEmbed {
  constructor(domSelector, viewConfig) {
    super(domSelector, powerBiConfig, viewConfig);
  }
}

export { SpotterEmbed, LiveboardEmbed, AuthType, tableauConfig, powerBiConfig, thoughtSpotConfig };
