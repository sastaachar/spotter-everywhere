/** @type {import('../spotter-embed/index.js').PlatformConfig} */
export const powerBiConfig = {
  platform: 'powerbi',
  label: 'Power BI',
  colors: {
    primary: '#f2c811',
    primaryHover: '#e0b600',
    primaryActive: '#c9a300',
    secondary: '#ffffff',
    secondaryHover: '#f3f2f1',
    background: '#ffffff',
    surface: '#f3f2f1',
    text: '#252423',
    textSecondary: '#605e5c',
    font: '"Segoe UI", "Segoe UI Web (West European)", -apple-system, BlinkMacSystemFont, Roboto, sans-serif',
  },
  cssVariables: {
    '--ts-var-button-border-radius': '2px',
    '--ts-var-button--primary-color': '#252423',
    // Tiles sit inside the host's own card, so they carry its shape and drop
    // the second shadow that made every tile look raised twice over.
    '--ts-var-viz-border-radius': '10px',
    '--ts-var-liveboard-tile-border-radius': '10px',
    '--ts-var-viz-box-shadow': 'none',
    '--ts-var-liveboard-layout-background': '#ffffff',
    '--ts-var-viz-background': '#ffffff',
    '--ts-var-viz-title-color': '#252423',
    '--ts-var-viz-title-font-family': '"Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, sans-serif',
    '--ts-var-viz-description-color': '#605e5c',
  },
  // A headline figure is set heavy enough to shout. There is no documented
  // variable for its weight, so it is dialled back through a rule — which is
  // why this is separate from cssVariables and why it fails quietly if
  // ThoughtSpot renames the class.
  cssRules: {
    '.bk-kpi-value, [data-testid="kpi-value"], .kpi-chart-value': {
      'font-weight': '600',
      'letter-spacing': '-0.02em',
    },
  },
  viewConfig: {
    hideSourceSelection: true,
    hideSampleQuestions: false,
    showSpotterLimitations: false,
  },
};
