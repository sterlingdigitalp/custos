/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        base: '#0A110D',
        surface: '#151E1A',
        sidebar: '#0E1612',
        divider: '#23302A',
        'text-primary': '#E8F0EC',
        'text-secondary': '#7C8D85',
        'text-muted': '#4A5A53',
        accent: '#BEF264',
        'accent-glow': '#2F5A38',
        'metric-down': '#E17055',
      },
      boxShadow: { panel: '0 18px 50px rgb(0 0 0 / 0.12)' },
    },
  },
  plugins: [],
}
