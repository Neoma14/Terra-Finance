type Mood = "happy" | "sad" | "neutral";

/** Mata & mulut di layar "wajah" robot -- satu-satunya bagian yang berubah
 * antar mood, biar animasi ekspresi murah (cuma ganti path, bukan re-render
 * seluruh SVG). */
function RobotFace({ mood }: { mood: Mood }) {
  if (mood === "happy") {
    return (
      <g stroke="#3CB371" strokeWidth="2.6" fill="none" strokeLinecap="round">
        <path d="M -11 1 Q -7 -6 -3 1" />
        <path d="M 3 1 Q 7 -6 11 1" />
        <path d="M -8 9 Q 0 15 8 9" />
      </g>
    );
  }
  if (mood === "sad") {
    return (
      <g stroke="#3CB371" strokeWidth="2.6" fill="none" strokeLinecap="round">
        <path d="M -11 -3 Q -7 3 -3 -2" />
        <path d="M 3 -2 Q 7 3 11 -3" />
        <path d="M -8 13 Q 0 7 8 13" />
      </g>
    );
  }
  return (
    <g fill="#3CB371">
      <circle cx="-6" cy="0" r="2.2" />
      <circle cx="6" cy="0" r="2.2" />
      <rect x="-5" y="9" width="10" height="2.4" rx="1.2" />
    </g>
  );
}

/**
 * Karakter maskot robot Terra -- ORIGINAL (SVG murni, bukan aset foto),
 * terinspirasi bentuk "robot kecil ramah" (kepala kotak membulat + layar
 * wajah + antena telinga + badan bulat) dalam palet brand navy/blue/cyan.
 * Ekspresi berubah reaktif: sedih saat login gagal, gembira saat berhasil,
 * netral selagi menunggu/mengisi form -- feedback emosional ringan yang
 * lebih ramah daripada sekadar teks error merah.
 */
export function RobotCharacter({
  mood,
  size = 64,
  tilt = 0,
  bounceDelayMs = 0,
}: {
  mood: Mood;
  size?: number;
  tilt?: number;
  bounceDelayMs?: number;
}) {
  const wrapperClass =
    mood === "happy"
      ? "animate-bounce"
      : mood === "sad"
        ? "translate-y-1 rotate-[-4deg] opacity-90"
        : "animate-[float_5s_ease-in-out_infinite]";

  return (
    <div
      className={`transition-all duration-300 ${wrapperClass}`}
      style={{ animationDelay: `${bounceDelayMs}ms`, transform: mood !== "sad" ? `rotate(${tilt}deg)` : undefined }}
    >
      <svg width={size} height={size} viewBox="-30 -34 60 68" fill="none">
        {/* telinga/antena */}
        <ellipse cx="-24" cy="-14" rx="5" ry="9" fill="#33495C" transform="rotate(-20 -24 -14)" />
        <ellipse cx="24" cy="-14" rx="5" ry="9" fill="#33495C" transform="rotate(20 24 -14)" />

        {/* lengan */}
        <ellipse
          cx={mood === "happy" ? -26 : -22}
          cy={mood === "happy" ? -2 : 10}
          rx="6"
          ry="11"
          fill="#F2F5F8"
          stroke="#DCE6F0"
          transform={mood === "happy" ? "rotate(-35 -26 -2)" : "rotate(-10 -22 10)"}
        />
        <ellipse cx="22" cy="10" rx="6" ry="11" fill="#F2F5F8" stroke="#DCE6F0" transform="rotate(12 22 10)" />

        {/* badan */}
        <path d="M -16 6 Q -18 26 0 30 Q 18 26 16 6 Z" fill="#F2F5F8" stroke="#DCE6F0" />
        <circle cx="0" cy="13" r="4" fill="#3CB371" opacity={mood === "sad" ? 0.35 : 0.9} />

        {/* kepala + layar wajah */}
        <rect x="-20" y="-26" width="40" height="32" rx="12" fill="#F2F5F8" stroke="#DCE6F0" />
        <rect x="-14" y="-20" width="28" height="20" rx="6" fill="#1C2B3A" />
        <g transform="translate(0 -10)">
          <RobotFace mood={mood} />
        </g>
      </svg>
    </div>
  );
}

/** Trio maskot -- tiga karakter dengan ukuran/tilt/animation-delay sedikit
 * berbeda supaya terasa seperti kelompok, bukan tiga salinan identik. */
export function LoginRobotTrio({ mood }: { mood: Mood }) {
  return (
    <div className="flex items-end justify-center gap-3">
      <RobotCharacter mood={mood} size={44} tilt={-6} bounceDelayMs={0} />
      <RobotCharacter mood={mood} size={60} tilt={0} bounceDelayMs={80} />
      <RobotCharacter mood={mood} size={44} tilt={6} bounceDelayMs={160} />
    </div>
  );
}
