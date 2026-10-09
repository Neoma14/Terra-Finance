import type { UserRole } from "@konsultan/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api-client.js";

export interface ManagedUser {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  isActive: boolean;
  createdAt: string;
}

export function useUsers() {
  return useQuery({
    queryKey: ["users"],
    queryFn: () => api.get<{ users: ManagedUser[] }>("/users"),
  });
}

export interface CreateUserInput {
  email: string;
  password: string;
  fullName: string;
  role: UserRole;
}

export function useCreateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateUserInput) => api.post<{ ok: true; userId: string }>("/users", input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["users"] }),
  });
}

export function useSetUserActive() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      api.patch<{ ok: true }>(`/users/${id}/active`, { isActive }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["users"] }),
  });
}
