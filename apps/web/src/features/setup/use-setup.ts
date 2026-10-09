import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api-client.js";

export function useSetupStatus() {
  return useQuery({
    queryKey: ["setup", "status"],
    queryFn: () => api.get<{ needsSetup: boolean }>("/setup/status"),
  });
}

export interface SetupCompleteInput {
  companyName: string;
  industry?: string;
  licenseKey: string;
  adminEmail: string;
  adminPassword: string;
  adminFullName: string;
}

export function useCompleteSetup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SetupCompleteInput) => api.post<{ ok: true }>("/setup/complete", input),
    // Tanpa ini, cache ["setup","status"] (dibaca SetupGate di App.tsx) masih
    // bilang needsSetup:true dari sebelum submit -- navigate("/login") sesudah
    // sukses langsung dilempar BALIK ke /setup krn SetupGate cek cache lama,
    // padahal data sudah benar tersimpan di server (kelihatan spt "wizard
    // muncul lagi" walau setup sebenarnya sudah berhasil).
    //
    // SEMPAT dicoba invalidateQueries() saja -- TERNYATA TIDAK CUKUP: query
    // ini TIDAK "active" selagi masih di halaman /setup (SetupGate yg
    // memantainya cuma ter-mount di route /login & /), jadi invalidateQueries
    // cuma menandai stale TANPA benar2 refetch (default refetchType:"active").
    // Begitu SetupGate mount di /login, ia baca cache LAMA (needsSetup:true)
    // dulu secara sinkron sebelum sempat refetch -- balik lagi ke bug yang
    // sama. Fix yang benar: langsung timpa cache dgn nilai yang SUDAH PASTI
    // benar (bukan menunggu refetch apa pun).
    onSuccess: () => {
      queryClient.setQueryData(["setup", "status"], { needsSetup: false });
    },
  });
}
