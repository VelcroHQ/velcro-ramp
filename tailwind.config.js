// Builds ramp.usevelcro.com/style.css. Re-run after adding Tailwind classes to the HTML,
// otherwise new classes silently do nothing:
//   npx tailwindcss@3.4.1 -c tailwind.config.js -i tailwind.css -o ramp.usevelcro.com/style.css --minify
module.exports = {
  content: ['./ramp.usevelcro.com/**/*.html'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        'velcro-green': { DEFAULT: '#a8cf45', dark: '#8fb336' },
        'velcro-navy': '#0d0d59',
        slate: { 750: '#283447' },
      },
      keyframes: {
        fadeIn: { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
      },
      animation: {
        'fade-in': 'fadeIn .3s ease-out',
      },
    },
  },
};
