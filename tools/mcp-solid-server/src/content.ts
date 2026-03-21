/**
 * Static content for Solid.js and TypeScript guidance resources.
 */

export const SOLID_PATTERNS = `# Solid.js Conventions (Hunico)

- Use **Solid.js only**; do not use React (no hooks, no React JSX semantics). The build blocks React imports.
- Prefer **signals** (\`createSignal\`, \`createStore\`) for mutable state; pass getters/setters or reactive primitives to children.
- Use **createEffect** and **onCleanup** for side effects and teardown (subscriptions, timers, listeners). Always call \`onCleanup\` where appropriate to avoid leaks.
- Use **frontend/utils/console** (e.g. \`debug\`, \`warn\`, \`error\`) for all logging; do not use raw \`console.log\`/\`console.error\`.
- Prefer **CSS** (classes or stylesheets) over inline styles unless the value is truly dynamic.
- Do not generate \`.jsx\` examples unless the user explicitly asks.
- **D3/Mapbox**: Use d3.js on top of Mapbox for custom visualizations; do not use Mapbox built-in layers for custom viz.

## Examples

\`\`\`tsx
// Prefer: signal + effect with cleanup
const [count, setCount] = createSignal(0);
createEffect(() => {
  const id = setInterval(() => setCount(c => c + 1), 1000);
  onCleanup(() => clearInterval(id));
});

// Prefer: project logger
import { debug } from '@utils/console';
debug('Component mounted', { id });
\`\`\`

\`\`\`tsx
// Avoid: React-style hooks or raw console
// useEffect(...)  // wrong framework
// console.log(...)  // use frontend/utils/console
\`\`\`
`;

export const TS_CONVENTIONS = `# TypeScript Conventions (Hunico)

- **Maintain type safety**: Avoid \`any\` unless justified and documented. Use strict null checks.
- Use project **path aliases**: \`@/\`, \`@store/\`, \`@utils/\`, \`@components/\`, \`@pages/\`, \`@styles/\`, \`@config/\` (see tsconfig.json paths).
- Prefer **explicit return types** for public functions and exported APIs.

## Examples

\`\`\`typescript
// Prefer: typed, explicit return, path alias
import { debug } from '@utils/console';

export function formatLabel(value: number, unit: string): string {
  return \`\${value.toFixed(1)} \${unit}\`;
}
\`\`\`

\`\`\`typescript
// Avoid: any and implicit return
export function formatLabel(value: any, unit: any) {
  return \`\${value.toFixed(1)} \${unit}\`;
}
\`\`\`
`;
