import type { Company, CreateCompanyInput } from "@konsultan/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api-client.js";

export function useCompanies() {
  return useQuery({
    queryKey: ["companies"],
    queryFn: () => api.get<{ companies: Company[] }>("/companies"),
  });
}

export function useCompany(slug: string | undefined) {
  return useQuery({
    queryKey: ["companies", slug],
    queryFn: () => api.get<{ company: Company }>(`/c/${slug}`),
    enabled: !!slug,
  });
}

export function useCreateCompany() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCompanyInput) => api.post<{ company: Company }>("/companies", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["companies"] }),
  });
}

export interface UpdateCompanyInput {
  name?: string;
  industry?: string;
  industryTemplate?: Company["industryTemplate"];
  fiscalYearStartMonth?: number;
  currency?: string;
  status?: Company["status"];
}

export function useUpdateCompany(companySlug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateCompanyInput) => api.patch<{ company: Company }>(`/c/${companySlug}`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["companies"] });
      qc.invalidateQueries({ queryKey: ["companies", companySlug] });
    },
  });
}

export function useUploadCompanyLogo(companySlug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => api.upload<{ logoUrl: string }>(`/c/${companySlug}/logo`, file),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["companies"] });
      qc.invalidateQueries({ queryKey: ["companies", companySlug] });
    },
  });
}

export function useDeleteCompanyLogo(companySlug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete(`/c/${companySlug}/logo`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["companies"] });
      qc.invalidateQueries({ queryKey: ["companies", companySlug] });
    },
  });
}
