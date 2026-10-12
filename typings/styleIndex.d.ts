/** Host-side shapes of the styles the plugin indexes (`addon.data.styles`). */
import type { StyleInfo } from "./style";

/** Metadata shown for one style in the style manager and the server list. */
export type StyleSummary = Pick<
  StyleInfo,
  "id" | "title" | "citationType" | "description" | "updated"
>;

/** A style in the plugin's index, with the file it was read from. */
export type StyleFile = StyleSummary & {
  filename: string;
};
