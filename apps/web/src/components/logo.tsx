import { useTheme } from "../theme/use-theme.js";

/** "auto" (default): ikut tema situs (light/dark) -- dipakai di permukaan
 * adaptif spt kartu login/setup-wizard. "always-dark": PAKSA varian ikon
 * untuk latar gelap terlepas dari tema situs -- dipakai di chrome yg
 * SENGAJA selalu gelap (sidebar, panel hero login), sama seperti kelas
 * `navy`/`cyan` statis di tailwind.config.js. */
type LogoVariant = "auto" | "always-dark";

export function Logo({ size = 28, variant = "auto" }: { size?: number; variant?: LogoVariant }) {
  const { theme } = useTheme();
  const useDarkIcon = variant === "always-dark" || theme === "dark";
  const src = useDarkIcon ? "/terra-icon-dark.png" : "/terra-icon-light.png";
  return (
    <img
      src={src}
      alt="TERRA FINANCE"
      height={size}
      style={{ height: size, width: "auto" }}
      onError={(e) => {
        e.currentTarget.style.display = "none";
      }}
    />
  );
}

export function PoweredByTerra() {
  return (
    <div className="flex items-center gap-2 text-xs text-ink/60">
      <Logo size={16} />
      <span>Powered by Terra Teknologi Digital</span>
    </div>
  );
}
