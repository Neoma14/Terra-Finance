import type { AuthUser, LoginInput } from "@konsultan/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api-client.js";

export function useMe() {
  return useQuery({
    queryKey: ["auth", "me"],
    queryFn: () => api.get<{ user: AuthUser }>("/auth/me"),
    retry: false,
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: LoginInput) => api.post<{ user: AuthUser }>("/auth/login", input),
    onSuccess: (data) => {
      qc.setQueryData(["auth", "me"], data);
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post("/auth/logout"),
    onSuccess: () => {
      // Urutan PENTING: clear() dulu (buang semua cache scoped-company demi
      // keamanan), BARU setQueryData -- kalau dibalik, clear() akan menimpa
      // balik nilai null yang baru saja di-set, memaksa useMe() fetch ulang
      // (bikin RequireAuth sempat nampilin "Memuat..." & redirect telat/
      // terasa macet alih-alih langsung ke /login).
      qc.clear();
      qc.setQueryData(["auth", "me"], null);
    },
  });
}

export function useUploadAvatar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => api.upload<{ avatarUrl: string }>("/auth/me/avatar", file),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["auth", "me"] }),
  });
}

export function useDeleteAvatar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete("/auth/me/avatar"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["auth", "me"] }),
  });
}
