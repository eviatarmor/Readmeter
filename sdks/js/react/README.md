# @readmeter/react

Component mount ids for [`@readmeter/firebase`](../firebase). Firebase calls a component makes inside its effects carry a mount id, so Readmeter can tell a React StrictMode double effect (one instance running its effect twice) from two components that each fetch the same data.

## Install

```sh
pnpm add @readmeter/react
```

Peer dependencies: `react` (`>=18`) and `@readmeter/firebase`. Call `init` from `@readmeter/firebase` as usual.

## Use

```tsx
import { onSnapshot, collection, query, limit } from "@readmeter/firebase/firestore";
import { useReadmeterEffect } from "@readmeter/react";

function Todos({ db }) {
  const [rows, setRows] = useState([]);
  useReadmeterEffect(() => onSnapshot(query(collection(db, "todos"), limit(50)), (snap) => setRows(snap.docs)), [db]);
  return <TodoList rows={rows} />;
}
```

- `useReadmeterEffect(effect, deps)` / `useReadmeterLayoutEffect(effect, deps)`: `useEffect` / `useLayoutEffect` whose effect and cleanup run inside a mount id the hook owns.
- `useMountId()`: a mount id owned by this hook call, stable across re-renders and StrictMode's simulated remount. `undefined` when tagging is off.
- `withMount(mount, fn)`: runs `fn` with `mount` as the current mount id. Only synchronous work is tagged; listeners keep the mount that opened them.
- `withReadmeterMount(Component)`: tags reads a function component makes while it renders.
- `ReadmeterProvider`: optional; `enabled={false}` turns tagging off for a subtree.

Nothing here throws into your app, and without `init` the hooks cost next to nothing. The raw call gets an integer `mount` field, a per-page counter; component names, props and state are never read.

Documentation: [docs/content/docs/sdk/react.mdx](../../../docs/content/docs/sdk/react.mdx).

## License

MIT
