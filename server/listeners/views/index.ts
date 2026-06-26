import type { App } from "@slack/bolt";
import sampleViewCallback from "./sample-view";
import scaffoldModifyViewCallback from "./scaffold-modify-view";

const register = (app: App) => {
  app.view("sample_view_id", sampleViewCallback);
  app.view("scaffold_modify_view", scaffoldModifyViewCallback);
};

export default { register };
