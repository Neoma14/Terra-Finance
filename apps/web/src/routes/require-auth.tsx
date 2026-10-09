import type { PropsWithChildren } from "react";
import { Navigate } from "react-router-dom";
import { useMe } from "../features/auth/use-auth.js";
import { useIdleLogout } from "../features/auth/use-idle-logout.js";

export function RequireAuth({ children }: PropsWithChildren) {
  const { data, isLoading, isError } = useMe();
  // Auto-logout setelah 15 menit tanpa aktivitas pengguna (hanya saat login).
  useIdleLogout(Boolean(data?.user));

  if (isLoading) {
    return <div className="flex h-screen items-center justify-center text-ink/50">Memuat...</div>;
  }
  if (isError || !data?.user) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}
