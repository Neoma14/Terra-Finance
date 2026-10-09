/**
 * Ubah error mentah (termasuk error driver SQLite/knex yang isinya bisa
 * berupa QUERY SQL PENUH ratusan baris -- pernah kejadian nyata: import
 * jurnal dgn entry berisi banyak baris melebihi batas parameter SQLite,
 * pesan error-nya jadi dump SQL mentah yang ditampilkan apa adanya ke user
 * lewat reply.send({error: err.message})) jadi pesan yang aman & ramah
 * ditampilkan ke user. Error ASLI selalu tetap di-log lengkap di server
 * (request.log.error) di tempat pemanggilan -- fungsi ini HANYA
 * membersihkan apa yang dikirim balik ke frontend.
 */
export function toUserErrorMessage(err: unknown, fallback = "Terjadi kesalahan. Coba lagi, atau hubungi dukungan kalau berulang."): string {
  const message = err instanceof Error ? err.message : String(err);

  // Ciri-ciri pesan error DB mentah yang TIDAK BOLEH ditampilkan apa
  // adanya: sangat panjang, atau mengandung potongan SQL/nama kolom teknis.
  const looksLikeRawSql =
    message.length > 300 ||
    /\binsert into\b|\bselect\b.*\bunion all\b|\bsqlite_/i.test(message) ||
    /`[a-z_]+`\s*[,)]/.test(message);

  if (looksLikeRawSql) return fallback;
  return message;
}
