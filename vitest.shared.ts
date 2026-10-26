import { defaultClientConditions, defaultServerConditions } from 'vite';

/**
 * Workspace packages export their TypeScript sources under the `@centinela/source`
 * condition, so tests, the dev server and typechecking never need a prior build.
 */
export const SOURCE_CONDITION = '@centinela/source';

export const nodeSourceResolve = {
  resolve: { conditions: [SOURCE_CONDITION, ...defaultServerConditions] },
  ssr: { resolve: { conditions: [SOURCE_CONDITION, ...defaultServerConditions] } },
};

export const browserSourceResolve = {
  resolve: { conditions: [SOURCE_CONDITION, ...defaultClientConditions] },
};
