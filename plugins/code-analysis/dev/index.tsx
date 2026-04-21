import { createDevApp } from '@backstage/dev-utils';
import { codeAnalysisPlugin, CodeAnalysisPage } from '../src/plugin';

createDevApp()
  .registerPlugin(codeAnalysisPlugin)
  .addPage({
    element: <CodeAnalysisPage />,
    title: 'Root Page',
    path: '/code-analysis',
  })
  .render();
