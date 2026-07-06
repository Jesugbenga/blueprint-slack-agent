import type { App } from "@slack/bolt";
import { GAP_FILL_VIEW } from "~/lib/slack/gap-blocks";
import { gapFillModalCallback } from "./gapFillModal";
import sampleViewCallback from "./sample-view";

const register = (app: App) => {
  app.view("sample_view_id", sampleViewCallback);
  // Feature 3 — context gap fill modal
  app.view(GAP_FILL_VIEW, gapFillModalCallback);
};

export default { register };
