/** Sign-in, ingest tokens and the audit log (S6) over the typed client. */
import {
  auditPageSchema,
  ingestTokenCreatedSchema,
  ingestTokenListSchema,
  ingestTokenSchema,
  sessionInfoSchema,
  type LoginBody,
} from '@centinela/shared';
import { z } from 'zod';
import { apiRequest, type QueryParams } from '../../api/client';

const enc = encodeURIComponent;

export const authApi = {
  /** `null` when signed out (a `401` here is an answer, not an error). */
  me: (signal?: AbortSignal) =>
    apiRequest('/auth/me', sessionInfoSchema, { signal, notifyUnauthorized: false }),
  login: (body: LoginBody) =>
    apiRequest('/auth/login', sessionInfoSchema, {
      method: 'POST',
      json: body,
      notifyUnauthorized: false,
    }),
  logout: () =>
    apiRequest('/auth/logout', z.undefined(), { method: 'POST', notifyUnauthorized: false }),
  listTokens: (signal?: AbortSignal) => apiRequest('/tokens', ingestTokenListSchema, { signal }),
  createToken: (label: string) =>
    apiRequest('/tokens', ingestTokenCreatedSchema, { method: 'POST', json: { label } }),
  revokeToken: (id: string) =>
    apiRequest(`/tokens/${enc(id)}/revoke`, ingestTokenSchema, { method: 'POST' }),
  listAudit: (params?: QueryParams, signal?: AbortSignal) =>
    apiRequest('/audit', auditPageSchema, { params, signal }),
};
