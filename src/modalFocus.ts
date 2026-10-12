import { useLayoutEffect, useRef, type RefObject } from "react";

const inertLocks = new WeakMap<HTMLElement, { count: number; previous: boolean }>();
let scrollLocks = 0, previousOverflow = "";
function lockInert(element: HTMLElement) {
  // Preserve inert owned by React/another overlay; do not overwrite it on exit.
  if (element.inert && !inertLocks.has(element)) return () => {};
  const lock = inertLocks.get(element) || { count: 0, previous: element.inert };
  lock.count++;
  inertLocks.set(element, lock);
  element.inert = true;
  return () => {
    if (--lock.count === 0) { element.inert = lock.previous; inertLocks.delete(element); }
  };
}

const controls = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(
  'button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,video[controls],[tabindex]:not([tabindex="-1"])',
)].filter((element) => element.tabIndex >= 0 && !element.closest("[inert]") && element.getClientRects().length);

// Same inert/Tab/return behavior as VisualReferences, for dialogs inside the root.
export function useModalFocus(open: boolean | string, ref: RefObject<HTMLElement | null>, onClose: () => void, opener?: RefObject<HTMLElement | null>) {
  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!open || !dialog) return;
    const previous = opener?.current || document.activeElement as HTMLElement | null;
    const returnScope = previous?.closest(".home-project");
    const releaseInert: (() => void)[] = [];
    let branch: HTMLElement = dialog;
    while (branch.parentElement) {
      for (const sibling of branch.parentElement.children) {
        if (sibling === branch || !(sibling instanceof HTMLElement)) continue;
        releaseInert.push(lockInert(sibling));
      }
      branch = branch.parentElement;
      if (branch === document.body) break;
    }
    if (scrollLocks++ === 0) previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const previousTabIndex = dialog.getAttribute("tabindex");
    if (previousTabIndex === null) dialog.tabIndex = -1;
    (dialog.querySelector<HTMLElement>("[data-modal-autofocus]") || controls(dialog)[0] || dialog).focus({ preventScroll: true });
    const key = (event: KeyboardEvent) => {
      if (dialog.closest("[inert]")) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        close.current();
      } else if (event.key === "Tab") {
        const items = controls(dialog), first = items[0], last = items.at(-1);
        if (!first || !last) {
          event.preventDefault();
          dialog.focus();
        } else if (!dialog.contains(document.activeElement) || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
      } else if (["w", "e", "r", "f", "delete", "backspace"].includes(event.key.toLowerCase()) || ((event.metaKey || event.ctrlKey) && ["z", "y"].includes(event.key.toLowerCase()))) {
        // Keep typing/native controls, but suppress workbench shortcuts in a modal.
        event.stopPropagation();
      }
    };
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      releaseInert.forEach(release => release());
      if (--scrollLocks === 0) document.body.style.overflow = previousOverflow;
      if (previousTabIndex === null) dialog.removeAttribute("tabindex");
      const target = previous?.isConnected ? previous : returnScope?.querySelector<HTMLElement>("button");
      if (target?.isConnected && !target.closest("[inert]")) target.focus({ preventScroll: true });
    };
  }, [open, ref, opener]);
}
