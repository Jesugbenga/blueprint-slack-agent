import type { App } from "@slack/bolt";
import {
  DESIGN_ADD_VIEW,
  DESIGN_EDIT_VIEW,
} from "~/lib/slack/design-blocks";
import designAddViewCallback from "./design-add-view";
import designEditViewCallback from "./design-edit-view";
import sampleViewCallback from "./sample-view";
import scaffoldModifyViewCallback from "./scaffold-modify-view";

const register = (app: App) => {
  app.view("sample_view_id", sampleViewCallback);
  app.view("scaffold_modify_view", scaffoldModifyViewCallback);
  // Collaborative design modals
  app.view(DESIGN_EDIT_VIEW, designEditViewCallback);
  app.view(DESIGN_ADD_VIEW, designAddViewCallback);
};

export default { register };
