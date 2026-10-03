/**
 * React bindings for `@readmeter/firebase`: each component instance gets a
 * stable mount id, and Firebase calls made synchronously inside its effects
 * (or its render, through `withMount`) carry that id. Rules use it to tell a
 * React StrictMode double effect (same instance) from two components that
 * each fetch the same data (two instances).
 *
 * Nothing here throws into the app. Without `init` from `@readmeter/firebase`
 * the hooks only set and restore a module variable around your callback.
 */

import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type DependencyList,
  type EffectCallback,
  type FunctionComponent,
  type ReactNode,
} from "react";
import * as firebase from "@readmeter/firebase";

// A namespace import, so an older @readmeter/firebase without the mount API
// leaves these undefined instead of failing to link the host's bundle.
const sdk = firebase as Partial<Pick<typeof firebase, "newMountId" | "runInMount">>;

interface ReadmeterContextValue {
  enabled: boolean;
}

const ReadmeterContext = createContext<ReadmeterContextValue>({ enabled: true });

export interface ReadmeterProviderProps {
  /** Tag Firebase calls in this subtree with mount ids. Default true. */
  enabled?: boolean;
  children?: ReactNode;
}

/**
 * Optional. The hooks work without a provider; use one to turn mount
 * tagging off for a subtree (`enabled={false}`).
 */
export function ReadmeterProvider({ enabled = true, children }: ReadmeterProviderProps): ReactNode {
  const value = useMemo(() => ({ enabled: enabled !== false }), [enabled]);
  return createElement(ReadmeterContext.Provider, { value }, children);
}

function allocate(): number | undefined {
  try {
    return typeof sdk.newMountId === "function" ? sdk.newMountId() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A mount id owned by this hook call in this component instance. Stable
 * across re-renders and across StrictMode's simulated unmount and remount,
 * which keep the instance's state; a new instance gets a new id. Each call
 * owns its own id, so call it once and pass the value to `withMount` to share
 * one id between several effects. `undefined` when a provider disabled
 * tagging.
 */
export function useMountId(): number | undefined {
  const { enabled } = useContext(ReadmeterContext);
  const [mount] = useState(allocate);
  return enabled ? mount : undefined;
}

/**
 * Runs `fn` with `mount` as the current mount id and returns its result.
 * Firebase calls made synchronously inside `fn` carry the id; listeners keep
 * it for their later snapshots and unsubscribe. `undefined` runs `fn` as is.
 * Errors thrown by `fn` propagate unchanged.
 */
export function withMount<T>(mount: number | undefined, fn: () => T): T {
  if (mount === undefined || typeof sdk.runInMount !== "function") return fn();
  return sdk.runInMount(mount, fn);
}

function tagged(mount: number | undefined, effect: EffectCallback): ReturnType<EffectCallback> {
  const cleanup = withMount(mount, effect);
  if (typeof cleanup !== "function") return cleanup;
  return () => withMount(mount, cleanup);
}

/**
 * `useEffect` whose effect and cleanup run inside a mount id this hook owns
 * (see `useMountId`).
 * Add it to `react-hooks/exhaustive-deps` with
 * `additionalHooks: "(useReadmeterEffect|useReadmeterLayoutEffect)"`.
 */
export function useReadmeterEffect(effect: EffectCallback, deps?: DependencyList): void {
  const mount = useMountId();
  useEffect(() => tagged(mount, effect), deps);
}

/** `useLayoutEffect` counterpart of `useReadmeterEffect`. */
export function useReadmeterLayoutEffect(effect: EffectCallback, deps?: DependencyList): void {
  const mount = useMountId();
  useLayoutEffect(() => tagged(mount, effect), deps);
}

/**
 * Wraps a function component so Firebase calls made while it renders carry
 * its mount id (reads in render are what `firebase.firestore/read-in-render`
 * looks for). The component is called as a function inside the wrapper, so
 * its hooks belong to the wrapper. Class components and exotic components
 * (`memo`, `forwardRef`) are rendered unchanged, without a mount.
 */
export function withReadmeterMount<P extends object>(Component: (props: P) => ReactNode): FunctionComponent<P> {
  const name =
    (Component as { displayName?: unknown }).displayName ?? (typeof Component === "function" ? Component.name : undefined);
  const isClass =
    typeof Component === "function" &&
    !!(Component as { prototype?: { isReactComponent?: unknown } }).prototype?.isReactComponent;
  function Mounted(props: P): ReactNode {
    const mount = useMountId();
    if (typeof Component !== "function" || isClass) {
      return createElement(Component as unknown as FunctionComponent<P>, props);
    }
    return withMount(mount, () => Component(props));
  }
  Mounted.displayName = `withReadmeterMount(${typeof name === "string" && name ? name : "Component"})`;
  return Mounted;
}
