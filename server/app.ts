import { App, LogLevel } from "@slack/bolt";
import { VercelReceiver } from "@vercel/slack-bolt";
import registerListeners from "./listeners";
import { messageClassifier } from "./listeners/events/messageClassifier";

const logLevel =
  process.env.NODE_ENV === "development" ? LogLevel.DEBUG : LogLevel.INFO;

const receiver = new VercelReceiver({
  logLevel,
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  receiver,
  deferInitialization: true,
  logLevel,
});

app.event("message", messageClassifier);
registerListeners(app);

export { app, receiver };
