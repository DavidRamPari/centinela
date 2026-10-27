/**
 * The content-pack playbook of a rule in the current UI language
 * (`GET /api/rules/:id/playbook?lang=en|es`). A `404` means the rule has no playbook (its
 * rule is Centinela's own, or the generator produced nothing for it): that is a normal
 * state, not an error, so the hook returns `null` for it.
 */
import {
  playbookResponseSchema,
  type PlaybookLanguage,
  type PlaybookResponse,
} from '@centinela/shared';
import { useQuery } from '@tanstack/react-query';
import { ApiError, apiRequest } from '../../../api/client';

export const playbookKey = (ruleId: string, lang: PlaybookLanguage) =>
  ['rules', 'playbook', ruleId, lang] as const;

export async function fetchPlaybook(
  ruleId: string,
  lang: PlaybookLanguage,
  signal?: AbortSignal,
): Promise<PlaybookResponse | null> {
  try {
    return await apiRequest(
      `/rules/${encodeURIComponent(ruleId)}/playbook`,
      playbookResponseSchema,
      {
        params: { lang },
        signal,
      },
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

export function usePlaybook(ruleId: string, lang: PlaybookLanguage) {
  return useQuery({
    queryKey: playbookKey(ruleId, lang),
    queryFn: ({ signal }) => fetchPlaybook(ruleId, lang, signal),
    // Playbooks only change when the server is redeployed with new content.
    staleTime: 60 * 60 * 1000,
  });
}
