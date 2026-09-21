/** @type {import('../spotter-embed/index.js').PlatformConfig} */
export const tableauConfig = {
  platform: 'tableau',
  label: 'Tableau',
  colors: {
    primary: '#1f77b4',
    primaryHover: '#16609a',
    primaryActive: '#124f80',
    secondary: '#ffffff',
    secondaryHover: '#eef4fb',
    background: '#ffffff',
    surface: '#f5f5f5',
    text: '#333333',
    textSecondary: '#666666',
    font: '"Tableau Book", Tableau, Arial, sans-serif',
  },
  cssVariables: {
    '--ts-var-button-border-radius': '4px',
  },
  viewConfig: {
    hideSourceSelection: true,
    hideSampleQuestions: false,
    showSpotterLimitations: false,
  },
};
