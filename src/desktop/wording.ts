import { isDesktop } from "./bridge";

/*
  The few words that differ between the Windows app and the browser version:
  where things are kept, and what holds the app.
*/
export const DESKTOP = isDesktop();
/** "on this computer" in the Windows app, "in this browser" otherwise. */
export const KEPT_HERE = DESKTOP ? "on this computer" : "in this browser";
/** What must stay in front for keyboard control: the window, or the tab. */
export const APP_WINDOW = DESKTOP ? "the AERONEX window" : "this browser tab";
