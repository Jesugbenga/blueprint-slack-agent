import type { AllMiddlewareArgs, SlackViewMiddlewareArgs } from "@slack/bolt";

const sampleViewCallback = async ({
  ack,
  view,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackViewMiddlewareArgs) => {
  try {
    await ack();
    const { input_block_id, select_channel_block_id } = view.state.values;
    const sampleInputValue = input_block_id.sample_input_id.value;
    const sampleConvoValue =
      select_channel_block_id.sample_dropdown_id.selected_conversation;

    await client.chat.postMessage({
      channel: sampleConvoValue || body.user.id,
      text: `<@${body.user.id}> submitted the following :sparkles: hopes and dreams :sparkles:: \n\n ${sampleInputValue}`,
    });
  } catch (error) {
    logger.error("View submission handler failed:", error);
    try {
      await client.chat.postEphemeral({
        channel: body.user.id,
        user: body.user.id,
        text: "Sorry, something went wrong handling your submission.",
      });
    } catch (notifyError) {
      logger.error("Also failed to notify user of error:", notifyError);
    }
  }
};

export default sampleViewCallback;
