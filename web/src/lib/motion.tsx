/**
 * In-app "animate the graph?" switch.
 *
 * The graph's signature flowing-particle edges used to key off the OS
 * `prefers-reduced-motion` media query. On locked-down machines (e.g. Windows
 * Enterprise with animations disabled by policy) that query reports `reduce`,
 * which silently killed the flow everywhere. This context makes motion an
 * app-level, user-controllable choice that DEFAULTS ON regardless of the OS
 * setting — so the demo's flow is visible by default, while a viewer who wants
 * calm can still turn it off from the header `Motion:` toggle.
 */
import { createContext, useContext } from "react";

/** True = animate (flowing particles + live render loop). Default true. */
export const MotionContext = createContext<boolean>(true);

/** Read the current app-level motion preference. */
export function useMotion(): boolean {
  return useContext(MotionContext);
}
