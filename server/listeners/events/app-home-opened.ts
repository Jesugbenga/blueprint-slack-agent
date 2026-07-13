import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";
import { publishHomeDashboard } from "~/lib/slack/dashboard";

const appHomeOpenedCallback = async ({
  client,
  event,
  context: ctx,
}: AllMiddlewareArgs & SlackEventMiddlewareArgs<"app_home_opened">) => {
  // Ignore the `app_home_opened` event for anything but the Home tab
  if (event.tab !== "home") return;
  await publishHomeDashboard(client, event.user, ctx.teamId);
};

export default appHomeOpenedCallback;
