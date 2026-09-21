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
  },
  viewConfig: {
    hideSourceSelection: true,
    hideSampleQuestions: false,
    showSpotterLimitations: false,
  },
};
