import { useLink } from "../state/linkStore";
import { notify } from "../state/notifyStore";

/*
  Keeps the app on the device so it opens with no internet (see the service
  worker in sw.template.js), and says when a newer version is ready.

  A new version is never taken by itself: the page it would reload may be
  linked to an aircraft. It is used the next time the app is opened, or at
  once if the user asks, and the offer to take it at once is not made while
  an aircraft is linked.
*/
export function startOffline() {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  // Service workers need a secure page; a file:// copy of the build has none.
  if (!window.isSecureContext) return;

  let asked = false;
  const offer = (reg: ServiceWorkerRegistration) => {
    const waiting = reg.waiting;
    if (!waiting || !navigator.serviceWorker.controller || asked) return;
    asked = true;
    const linked = useLink.getState().status === "connected" || useLink.getState().status === "stale";
    if (linked) {
      notify("info", "A newer AERONEX is ready", "It will be used the next time you open the app. Nothing changes while an aircraft is linked.");
      return;
    }
    notify("info", "A newer AERONEX is ready", "Reload to use it now, or carry on: it is used the next time you open the app.", {
      label: "Reload",
      run: () => {
        if (useLink.getState().status === "connected") return notify("warn", "Not while an aircraft is linked", "Disconnect first, then reload the page.");
        navigator.serviceWorker.addEventListener("controllerchange", () => window.location.reload(), { once: true });
        waiting.postMessage("take-over");
      },
    });
  };

  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("./sw.js")
      .then((reg) => {
        offer(reg);
        reg.addEventListener("updatefound", () => {
          const next = reg.installing;
          next?.addEventListener("statechange", () => {
            if (next.state === "installed") offer(reg);
          });
        });
      })
      .catch(() => {
        /* no offline copy: the app still works online */
      });
  });
}
