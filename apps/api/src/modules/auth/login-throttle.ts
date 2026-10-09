/**
 * Pembatas percobaan login (UAT-006). In-memory -- SENGAJA tidak disimpan di
 * database: restart server selalu mereset, jadi akun tidak mungkin terkunci
 * permanen. Semua blokir bersifat sementara (cooldown), dan TIDAK bergantung
 * pada apakah akun ada (kunci = teks identifier yang dikirim), sehingga
 * tidak membuka user enumeration.
 *
 * Tiga lapis, jendela geser 15 menit:
 *  - IP + identifier : 5 gagal -> blokir 5 menit (menahan tebak password satu akun)
 *  - identifier      : 20 gagal dari IP mana pun -> blokir 5 menit
 *  - IP              : 30 gagal ke identifier mana pun -> blokir 5 menit (password spraying)
 * Login berhasil mereset lapis IP+identifier dan identifier; hitungan IP
 * tetap berjalan sampai jendelanya habis.
 */
export const THROTTLE_WINDOW_MS = 15 * 60 * 1000;
export const THROTTLE_BLOCK_MS = 5 * 60 * 1000;
export const LIMIT_PAIR = 5;
export const LIMIT_IDENTIFIER = 20;
export const LIMIT_IP = 30;
const MAX_TRACKED_KEYS = 10_000;

interface Bucket {
  failures: number[]; // epoch ms tiap kegagalan di dalam jendela
  blockedUntil: number;
}

export interface ThrottleDecision {
  blocked: boolean;
  retryAfterSeconds: number;
}

export function normalizeIdentifier(raw: unknown): string {
  return String(raw ?? "").normalize("NFKC").trim().toLowerCase().slice(0, 254);
}

export class LoginThrottle {
  private buckets = new Map<string, Bucket>();

  constructor(private now: () => number = Date.now) {}

  private keys(ip: string, identifier: string) {
    return { pair: `p|${ip}|${identifier}`, id: `i|${identifier}`, ip: `a|${ip}` };
  }

  private fresh(key: string, t: number): Bucket | undefined {
    const b = this.buckets.get(key);
    if (!b) return undefined;
    b.failures = b.failures.filter((f) => t - f < THROTTLE_WINDOW_MS);
    if (b.failures.length === 0 && b.blockedUntil <= t) {
      this.buckets.delete(key);
      return undefined;
    }
    return b;
  }

  /** Cek sebelum memverifikasi password. */
  check(ip: string, identifierRaw: unknown): ThrottleDecision {
    const t = this.now();
    const k = this.keys(ip, normalizeIdentifier(identifierRaw));
    let until = 0;
    for (const key of [k.pair, k.id, k.ip]) {
      const b = this.fresh(key, t);
      if (b && b.blockedUntil > until) until = b.blockedUntil;
    }
    if (until > t) return { blocked: true, retryAfterSeconds: Math.max(1, Math.ceil((until - t) / 1000)) };
    return { blocked: false, retryAfterSeconds: 0 };
  }

  recordFailure(ip: string, identifierRaw: unknown): void {
    const t = this.now();
    const k = this.keys(ip, normalizeIdentifier(identifierRaw));
    const rules: Array<[string, number]> = [[k.pair, LIMIT_PAIR], [k.id, LIMIT_IDENTIFIER], [k.ip, LIMIT_IP]];
    for (const [key, limit] of rules) {
      const b = this.fresh(key, t) ?? { failures: [], blockedUntil: 0 };
      b.failures.push(t);
      if (b.failures.length >= limit) b.blockedUntil = t + THROTTLE_BLOCK_MS;
      this.buckets.set(key, b);
    }
    if (this.buckets.size > MAX_TRACKED_KEYS) this.prune(t);
  }

  recordSuccess(ip: string, identifierRaw: unknown): void {
    const k = this.keys(ip, normalizeIdentifier(identifierRaw));
    this.buckets.delete(k.pair);
    this.buckets.delete(k.id);
  }

  reset(): void {
    this.buckets.clear();
  }

  private prune(t: number): void {
    for (const key of [...this.buckets.keys()]) this.fresh(key, t);
    // Masih terlalu banyak (serangan dgn identifier acak): buang yang tertua.
    if (this.buckets.size > MAX_TRACKED_KEYS) {
      const excess = this.buckets.size - MAX_TRACKED_KEYS;
      let i = 0;
      for (const key of this.buckets.keys()) {
        if (i++ >= excess) break;
        this.buckets.delete(key);
      }
    }
  }
}

export const loginThrottle = new LoginThrottle();
