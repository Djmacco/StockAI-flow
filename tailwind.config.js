/** Design tokens come from the Stitch "Executive Precision" (light) and
 *  "Kinetic Industrial Precision" (dark) design systems. Colours are CSS
 *  variables so the theme can be switched at runtime from Settings. */
const c = (v) => `rgb(var(--${v}) / <alpha-value>)`;
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        canvas: c('canvas'),
        surface: c('surface'),
        muted: c('muted'),
        line: c('line'),
        'line-strong': c('line-strong'),
        ink: c('ink'),
        body: c('body'),
        faint: c('faint'),
        brand: c('brand'),
        'brand-hover': c('brand-hover'),
        'brand-soft': c('brand-soft'),
        'on-brand': c('on-brand'),
        ok: c('ok'), 'ok-soft': c('ok-soft'), 'ok-text': c('ok-text'),
        warn: c('warn'), 'warn-soft': c('warn-soft'), 'warn-text': c('warn-text'),
        bad: c('bad'), 'bad-soft': c('bad-soft'), 'bad-text': c('bad-text'),
        ai: c('ai'), 'ai-soft': c('ai-soft'), 'ai-text': c('ai-text'),
      },
      fontFamily: {
        display: ['Chivo', 'system-ui', 'sans-serif'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      borderRadius: { DEFAULT: '0.375rem', lg: '0.5rem', xl: '0.75rem' },
      boxShadow: {
        card: '0 1px 3px 0 rgb(15 23 42 / 0.05), 0 1px 2px -1px rgb(15 23 42 / 0.03)',
        pop: '0 4px 6px -1px rgb(15 23 42 / 0.07), 0 2px 4px -2px rgb(15 23 42 / 0.05)',
        modal: '0 10px 15px -3px rgb(15 23 42 / 0.12), 0 4px 6px -4px rgb(15 23 42 / 0.06)',
      },
    },
  },
  plugins: [],
};
