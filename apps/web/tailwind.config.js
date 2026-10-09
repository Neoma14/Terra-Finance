/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    // Tanpa efek bayangan di seluruh aplikasi (keputusan desain: tampilan datar,
    // warna solid). Semua utilitas shadow-* dipetakan ke "none" supaya class
    // shadow yang tidak sengaja ditambahkan nanti tidak memunculkan bayangan.
    // (Ring fokus aksesibilitas memakai utilitas ring-*, tidak terpengaruh.)
    boxShadow: {
      DEFAULT: "none",
      sm: "none",
      md: "none",
      lg: "none",
      xl: "none",
      "2xl": "none",
      inner: "none",
      card: "none",
      popover: "none",
      glow: "none",
      none: "none",
    },
    dropShadow: { DEFAULT: "none", sm: "none", md: "none", lg: "none", xl: "none", "2xl": "none", none: "none" },
    extend: {
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
      },
      colors: {
        // Semantik & adaptif tema (lihat src/theme/tokens.css) -- dipakai
        // untuk hampir semua permukaan/teks di area konten.
        bg: "rgb(var(--bg) / <alpha-value>)",
        surface: "rgb(var(--surface) / <alpha-value>)",
        "surface-2": "rgb(var(--surface-2) / <alpha-value>)",
        line: "rgb(var(--line) / <alpha-value>)",
        ink: "rgb(var(--ink) / <alpha-value>)",
        heading: "rgb(var(--heading) / <alpha-value>)",
        accent: {
          DEFAULT: "rgb(var(--accent) / <alpha-value>)",
          50: "rgb(var(--accent) / 0.08)",
          100: "rgb(var(--accent) / 0.16)",
          600: "rgb(var(--accent-hover) / <alpha-value>)",
        },
        // Statis (TIDAK berubah per tema) -- dipakai khusus untuk sidebar &
        // panel branding yang sengaja selalu gelap terlepas dari tema situs.
        // Identitas brand TERRA baru (logo "panah pertumbuhan" 2026): Dark
        // Charcoal/Navy + Forest Green sbg SATU-SATUNYA aksen non-navy
        // (menggantikan navy+cyan lama).
        navy: {
          DEFAULT: "#1C2B3A",
          50: "#eef1f3",
          100: "#dce2e6",
          600: "#33495c",
          700: "#1C2B3A",
          800: "#131e29",
          900: "#0b1319",
        },
        // Aksen hijau -- satu-satunya warna "hidup" non-navy di brand Terra
        // (dulu cyan), dipakai KHUSUS untuk momen highlight (focus glow,
        // active menu, indikator tren positif, garis chart aksen). Nama
        // token "cyan" SENGAJA dipertahankan (bukan diganti "green") supaya
        // ratusan pemakaian `bg-cyan-500`/`text-cyan-300`/`accent-cyan-500`
        // di seluruh aplikasi otomatis ikut berubah warna tanpa perlu
        // disentuh satu-satu -- cuma NILAI di sini yang berubah.
        cyan: {
          DEFAULT: "#2E8B57",
          200: "#A7E0C1",
          300: "#7DD3A8",
          400: "#3CB371",
          500: "#1F7A52",
          600: "#176440",
          700: "#124F33",
        },
      },
      backdropBlur: {
        xs: "2px",
      },
    },
  },
  plugins: [],
};
