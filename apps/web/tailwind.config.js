/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Original palette: aged parchment and iron in light, deep night-indigo in dark.
        // No third-party game assets or trademarked colours are used anywhere in Guild Hall.
        parchment: {
          50: '#fbf8f1',
          100: '#f4eee0',
          200: '#e8dcc4',
          300: '#d8c6a3',
          400: '#c2a97c',
        },
        ink: {
          500: '#5b5344',
          600: '#463f33',
          700: '#332e25',
          800: '#241f19',
          900: '#16130f',
        },
        night: {
          700: '#232744',
          800: '#1a1c33',
          850: '#151726',
          900: '#101120',
          950: '#0a0b16',
        },
        ember: {
          400: '#d98a3d',
          500: '#c4762c',
          600: '#a75f1f',
        },
        sigil: {
          300: '#8fa5d8',
          400: '#6b83c4',
          500: '#4f66aa',
          600: '#3d5090',
        },
        moss: { 400: '#6f9c6b', 500: '#568552', 600: '#436a40' },
        rust: { 400: '#c0604f', 500: '#a44a3a', 600: '#87392b' },
        gold: { 400: '#c9a227', 500: '#a8871d', 600: '#856a15' },
      },
      fontFamily: {
        display: ['Iowan Old Style', 'Palatino Linotype', 'Georgia', 'serif'],
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      boxShadow: {
        panel: '0 1px 2px rgb(0 0 0 / 0.06), 0 8px 24px -12px rgb(0 0 0 / 0.18)',
      },
    },
  },
  plugins: [],
};
