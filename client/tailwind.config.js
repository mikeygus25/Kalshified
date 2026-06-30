/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        bg:     "#0b0f18",
        card:   "#131825",
        border: "#1e2635",
      },
    },
  },
  plugins: [],
};
