/* Tailwind v4: a single PostCSS plugin replaces v3's tailwindcss + autoprefixer
 * pair. Lightning CSS (bundled inside @tailwindcss/postcss) handles vendor
 * prefixing, so autoprefixer is no longer needed. */
module.exports = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};
