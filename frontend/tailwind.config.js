/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "class",
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: {
          primary: "#080c12",
          secondary: "#0d1520",
          card: "#0f1a26",
        },
        border: {
          DEFAULT: "#1a2d42",
          glow: "#1e4060",
        },
        accent: {
          DEFAULT: "#00d4ff",
          dim: "#0090b3",
        },
        danger: "#ff4444",
        warning: "#ffaa00",
        success: "#00cc66",
      },
      fontFamily: {
        mono: ["JetBrains Mono", "monospace"],
        sans: ["Space Grotesk", "sans-serif"],
      },
      animation: {
        "pulse-slow": "pulse 3s ease-in-out infinite",
        "glow": "glow 2s ease-in-out infinite alternate",
      },
    },
  },
  plugins: [],
};
