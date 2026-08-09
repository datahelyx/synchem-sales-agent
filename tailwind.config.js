/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        /*
         * SynChem Global's own colours, taken from their logo and site:
         *   navy   #172554  (site headings and header)
         *   red    #d51b29 / #d02030 (logo mark)
         *   cyan   #00a0e0  (logo mark)
         *   ink    #303030  (logo wordmark)
         *
         * `brand` is the navy — it carries primary actions and the active nav.
         * Red and cyan are accents, deliberately sparing: red especially, so it
         * never competes with the error states already using rose.
         */
        brand: {
          50: '#eef2fb', 100: '#d9e1f4', 200: '#b6c6e8', 300: '#8aa3d6',
          400: '#5a79ba', 500: '#375698', 600: '#243f79', 700: '#172554',
          800: '#121d42', 900: '#0d1531',
        },
        accent: {
          50: '#fdecee', 100: '#fad1d5', 200: '#f5a5ac', 300: '#ee6d78',
          400: '#e33d4c', 500: '#d51b29', 600: '#b31522', 700: '#8d111b',
          800: '#6b0d15', 900: '#4a090e',
        },
        marine: {
          50: '#e6f6fd', 100: '#bfe8fa', 200: '#8ed7f6', 300: '#4dc1f0',
          400: '#17ade8', 500: '#00a0e0', 600: '#0083b8', 700: '#006590',
          800: '#004b6b', 900: '#003248',
        },
        ink: '#303030',
      },
      fontFamily: {
        sans: ['Inter', 'Segoe UI', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 2px rgba(16,24,40,.06), 0 1px 3px rgba(16,24,40,.1)',
        lift: '0 8px 24px rgba(16,24,40,.12)',
      },
    },
  },
  plugins: [],
};
