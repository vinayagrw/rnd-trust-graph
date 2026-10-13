/**
 * Modal focus management for dialogs/panels. While the referenced node is mounted:
 *   - move focus into it on open (first focusable element, else the container),
 *   - keep Tab / Shift+Tab cycling INSIDE it (so focus can't escape to the page
 *     behind the modal),
 *   - restore focus to whatever was focused before, on close.
 *
 * Pair this with `role="dialog"` + `aria-modal="true"` + an accessible label on the
 * same node so assistive tech announces the modal and the trap matches the ARIA
 * contract. Esc-to-close is handled by each dialog (or App) separately.
 */
import { useEffect, type RefObject } from "react";

const FOCUSABLE = [
  "a[href]",
  "area[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "button:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(",");

export function useFocusTrap(ref: RefObject<HTMLElement | null>, active = true): void {
  useEffect(() => {
    const node = ref.current;
    if (!active || !node) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    // Only elements that are actually visible (offsetParent is null for
    // display:none / detached, but NOT for position:fixed — which our modals use).
    const focusable = () =>
      Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || getComputedStyle(el).position === "fixed",
      );

    // Move focus in: first focusable, else the container itself.
    const initial = focusable()[0];
    if (initial) {
      initial.focus();
    } else {
      node.setAttribute("tabindex", "-1");
      node.focus();
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const els = focusable();
      if (els.length === 0) {
        e.preventDefault();
        return;
      }
      const first = els[0];
      const last = els[els.length - 1];
      const activeEl = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (activeEl === first || !node.contains(activeEl)) {
          e.preventDefault();
          last.focus();
        }
      } else if (activeEl === last || !node.contains(activeEl)) {
        e.preventDefault();
        first.focus();
      }
    };

    node.addEventListener("keydown", onKeyDown);
    return () => {
      node.removeEventListener("keydown", onKeyDown);
      // Restore focus to the opener if it's still in the document.
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [ref, active]);
}
