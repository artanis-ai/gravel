/** Tailwind preset matches the Gravel/Mallet brand palette. */
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: '#9B4340',
        'primary-light': '#C4716A',
        'primary-dark': '#7A3835',
        accent: '#D4A76A',
        'accent-light': '#F0D9A8',
        'earth-dark': '#4E3222',
        earth: '#6B4226',
        'earth-light': '#8B5E3C',
        'earth-warm': '#7A5238',
        forest: '#4A7C59',
        'forest-light': '#6BA37A',
        cream: '#FFFBF5',
        warm: '#F5EDE3',
        'text-dark': '#2D1810',
        'text-mid': '#6B5744',
        'text-muted': '#9A8B7A',
      },
      fontFamily: {
        sans: ['DM Sans', 'system-ui', 'sans-serif'],
        display: ['Fredoka', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
}
