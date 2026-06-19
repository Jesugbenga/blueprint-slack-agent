import type {
  AllMiddlewareArgs,
  SlackCommandMiddlewareArgs,
} from "@slack/bolt";

export const sampleCommandCallback = async ({
  ack,
  respond,
  logger,
}: AllMiddlewareArgs & SlackCommandMiddlewareArgs) => {
  try {
    await ack();
    await respond({
      text: "Responding to the sample command!",
      response_type: "ephemeral",
    });
  } catch (error) {
    logger.error("Slash command handler failed:", error);
    try {
      await respond({
        text: "Sorry, something went wrong handling that command.",
        response_type: "ephemeral",
      });
    } catch (respondError) {
      logger.error("Also failed to send error response:", respondError);
    }
  }
};
