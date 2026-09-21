import { SpotterEmbed, init, AuthType } from '@thoughtspot/visual-embed-sdk';
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

/**
 * init() pinned to cookieless trusted auth; the token comes from our backend.
 * thoughtSpotHost defaults to the configured cluster.
 * @param {Omit<import('@thoughtspot/visual-embed-sdk').EmbedConfig, 'authType' | 'thoughtSpotHost'> & { thoughtSpotHost?: string, getAuthToken: () => Promise<string> }} config
 */
export function initSpotter(config) {
  return init({ thoughtSpotHost: thoughtSpotConfig.host, ...config, authType: AuthType.TrustedAuthTokenCookieless });
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

export { SpotterEmbed, AuthType, tableauConfig, powerBiConfig, thoughtSpotConfig };
