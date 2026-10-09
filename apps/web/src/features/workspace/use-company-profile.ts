import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { companyApi } from "../../lib/company-api-client.js";
import type { CompanyProfile, UpdateCompanyProfileInput } from "./company-profile-types.js";

export function useCompanyProfile(companySlug: string) {
  return useQuery({
    queryKey: ["workspace", "profile", companySlug],
    queryFn: () => companyApi.get<{ profile: CompanyProfile }>(`/${companySlug}/profile`),
    enabled: Boolean(companySlug),
  });
}

export function useUpdateCompanyProfile(companySlug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateCompanyProfileInput) => companyApi.patch<{ success: true; profile: CompanyProfile }>(`/${companySlug}/profile`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workspace", "profile", companySlug] }),
  });
}
