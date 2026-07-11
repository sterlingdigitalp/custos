/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#172033',
        custos: { 50: '#eff8ff', 100: '#dbeefe', 500: '#2383cf', 600: '#146daf', 700: '#12588b' },
      },
      boxShadow: { panel: '0 1px 2px rgb(15 23 42 / 0.05), 0 8px 24px rgb(15 23 42 / 0.04)' },
    },
  },
  plugins: [],
}
