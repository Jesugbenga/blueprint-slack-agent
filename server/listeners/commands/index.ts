import type { App } from "@slack/bolt";
import { blueprintCommandCallback } from "./blueprint-command";
import { sampleCommandCallback } from "./sample-command";

const register = (app: App) => {
  app.command("/blueprint", blueprintCommandCallback);
  app.command("/sample-command", sampleCommandCallback);
};

export default { register };
