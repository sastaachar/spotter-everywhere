import { describe, expect, test } from 'bun:test';

globalThis.window ??= globalThis;
globalThis.document ??= { querySelector: () => null, addEventListener() {}, createElement: () => ({ style: {} }) };

const mod = await import('../index.js');
const { TableauSpotterEmbed, PowerBiSpotterEmbed, PlatformSpotterEmbed, SpotterEmbed, tableauConfig, powerBiConfig, viewConfigFor, cssVariablesFor, customizationsFor } = mod;

describe('exports', () => {
  test('presets extend the SDK SpotterEmbed', () => {
    expect(Object.getPrototypeOf(TableauSpotterEmbed)).toBe(PlatformSpotterEmbed);
    expect(Object.getPrototypeOf(PlatformSpotterEmbed)).toBe(SpotterEmbed);
    expect(Object.getPrototypeOf(PowerBiSpotterEmbed)).toBe(PlatformSpotterEmbed);
  });
});

describe('cluster', () => {
  test('thoughtSpotConfig points at an https host', () => {
    expect(mod.thoughtSpotConfig.host).toMatch(/^https:\/\/[^/]+$/);
  });
});

describe('theme', () => {
  test('colors map onto ThoughtSpot CSS variables', () => {
    const vars = cssVariablesFor(tableauConfig);
    expect(vars['--ts-var-button--primary-background']).toBe(tableauConfig.colors.primary);
    expect(vars['--ts-var-root-font-family']).toBe(tableauConfig.colors.font);
    expect(vars['--ts-var-button-border-radius']).toBe('4px');
  });

  test('raw cssVariables in a config override the derived ones', () => {
    const vars = cssVariablesFor(powerBiConfig);
    expect(vars['--ts-var-button--primary-color']).toBe('#252423');
    expect(vars['--ts-var-button--primary-background']).toBe('#f2c811');
  });

  test('caller customizations merge on top of the platform theme', () => {
    const merged = customizationsFor(tableauConfig, {
      content: { strings: { Spotter: 'Ask' } },
      style: { customCSS: { variables: { '--ts-var-root-background': '#000000' }, rules_UNSTABLE: { body: { margin: '0' } } } },
    });
    expect(merged.content.strings.Spotter).toBe('Ask');
    expect(merged.style.customCSS.rules_UNSTABLE.body.margin).toBe('0');
    expect(merged.style.customCSS.variables['--ts-var-root-background']).toBe('#000000');
    expect(merged.style.customCSS.variables['--ts-var-button--primary-background']).toBe(tableauConfig.colors.primary);
  });

  test('viewConfigFor layers platform defaults, caller view config, and theme', () => {
    const vc = viewConfigFor(powerBiConfig, { worksheetId: 'ws-1', hideSourceSelection: false });
    expect(vc.worksheetId).toBe('ws-1');
    expect(vc.hideSourceSelection).toBe(false);
    expect(vc.hideSampleQuestions).toBe(false);
    expect(vc.customizations.style.customCSS.variables['--ts-var-root-color']).toBe(powerBiConfig.colors.text);
  });

  test('platform configs differ only in theme and platform-level defaults', () => {
    for (const cfg of [tableauConfig, powerBiConfig]) {
      expect(cfg.platform).toMatch(/^[a-z][a-z0-9_-]*$/);
      expect(Object.keys(cfg.colors).sort()).toEqual(
        ['background', 'font', 'primary', 'primaryActive', 'primaryHover', 'secondary', 'secondaryHover', 'surface', 'text', 'textSecondary']
      );
    }
  });
});
