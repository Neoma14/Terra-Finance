// Pramuat uji (--import): menggeser jam proses server sebesar UAT_CLOCK_OFFSET_DAYS hari agar kedaluwarsa dapat diuji tanpa
// memanipulasi kolom database. HANYA untuk server uji terisolasi; tidak dipakai aplikasi sungguhan.
const offset = Number(process.env.UAT_CLOCK_OFFSET_DAYS ?? 0) * 86_400_000;
if (offset !== 0) {
  const RealDate = Date;
  class ShiftedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(RealDate.now() + offset);
      else super(...args);
    }
    static now() {
      return RealDate.now() + offset;
    }
  }
  globalThis.Date = ShiftedDate;
}
