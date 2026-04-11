/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // Scottish Coast primary palette
        ocean: {
          50: '#F5F8FA',
          100: '#DFECF2',
          200: '#B8D5E3',
          300: '#7BB5CC',
          400: '#3A7FA0',
          500: '#2A6580',
          600: '#1E4560',
          700: '#193A50',
          800: '#132E40',
          900: '#0E2230',
        },
        // Management accent — sunshine yellow
        sun: {
          50: '#FEF5CC',
          100: '#FDEEA3',
          200: '#F9DD5A',
          300: '#F5C518',
          400: '#D4AA14',
          500: '#9E7F10',
          600: '#6B560B',
        },
        // Client accent — blue-teal
        surf: {
          50: '#D0F3F8',
          100: '#A8E8F0',
          200: '#5DD0E0',
          300: '#12AABC',
          400: '#0E8E9E',
          500: '#0A6E7C',
          600: '#075058',
        },
        // Staff accent — soft violet
        violet: {
          50: '#E8E4F5',
          100: '#D5CEEC',
          200: '#B5ABDA',
          300: '#7C6EBF',
          400: '#6558A8',
          500: '#4C3D8F',
          600: '#362B6B',
        },
      },
    },
  },
  plugins: [],
};
