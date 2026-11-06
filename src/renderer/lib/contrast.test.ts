import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** WCAG relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

const css = readFileSync(resolve(__dirname, '../styles/theme.css'), 'utf8');

/** Extracts the variables of a theme block identified by its selector text. */
function block(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  const vars: Record<string, string> = {};
  for (const m of css.slice(open, close).matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) vars[m[1]] = m[2];
  return vars;
}

const TYPES = ['object', 'array', 'string', 'number', 'boolean', 'null', 'bignum'];

describe.each([
  ['light', block(":root[data-theme='light']")],
  ['dark (explicit)', block(":root[data-theme='dark']")],
  ['dark (system)', block(":root:not([data-theme='light'])")],
])('%s theme badges meet WCAG AA', (_name, vars) => {
  it.each(TYPES)('%s badge text vs its pill background', (t) => {
    expect(contrast(vars[`badge-${t}-fg`], vars[`badge-${t}-bg`])).toBeGreaterThanOrEqual(4.5);
  });
  it.each(TYPES)('%s value text vs row background and selected row', (t) => {
    expect(contrast(vars[`badge-${t}-fg`], vars['row-bg'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(vars[`badge-${t}-fg`], vars['row-selected'])).toBeGreaterThanOrEqual(4.5);
  });
  it('body text', () => {
    expect(contrast(vars.text, vars['row-bg'])).toBeGreaterThanOrEqual(7);
    expect(contrast(vars['text-muted'], vars.surface)).toBeGreaterThanOrEqual(4.5);
  });
});
