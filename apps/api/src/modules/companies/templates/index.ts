import type { IndustryTemplate } from "@konsultan/shared";
import { bankingTemplate } from "./banking.js";
import { cooperativeTemplate } from "./cooperative.js";
import { generalTemplate } from "./general.js";
import { hospitalTemplate } from "./hospital.js";
import type { ChartOfAccountsTemplate } from "./types.js";

export const CHART_OF_ACCOUNTS_TEMPLATES: Record<IndustryTemplate, ChartOfAccountsTemplate> = {
  general: generalTemplate,
  hospital: hospitalTemplate,
  banking: bankingTemplate,
  cooperative: cooperativeTemplate,
};

export function getTemplate(key: IndustryTemplate): ChartOfAccountsTemplate {
  return CHART_OF_ACCOUNTS_TEMPLATES[key];
}

export type { ChartOfAccountsTemplate, TemplateAccount } from "./types.js";
