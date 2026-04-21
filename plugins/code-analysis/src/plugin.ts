import {
  createPlugin,
  createApiFactory,
  discoveryApiRef,
  fetchApiRef,
  createRoutableExtension,
  // 1. Import identityApiRef
  identityApiRef,
} from '@backstage/core-plugin-api';
import { codeAnalysisApiRef, CodeAnalysisApiClient } from './api';
import { rootRouteRef } from './routes';

export const codeAnalysisPlugin = createPlugin({
  id: 'code-analysis',
  apis: [
    createApiFactory({
      api: codeAnalysisApiRef,
      deps: {
        discoveryApi: discoveryApiRef,
        fetchApi: fetchApiRef,
        // 2. Add identityApiRef as a dependency
        identityApi: identityApiRef,
      },
      // 3. Pass it to the client's factory
      factory: ({ discoveryApi, fetchApi, identityApi }) =>
        new CodeAnalysisApiClient({ discoveryApi, fetchApi, identityApi }),
    }),
  ],
  routes: {
    root: rootRouteRef,
  },
});


export const CodeAnalysisPage = codeAnalysisPlugin.provide(
  createRoutableExtension({
    name: 'CodeAnalysisPage',
    component: () =>
      import('./components/AnalysisPageComponent').then(
        m => m.AnalysisPageComponent,
      ),
    mountPoint: rootRouteRef,
  }),
);