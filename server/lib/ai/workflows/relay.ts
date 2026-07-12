import { sleep } from "workflow";

export interface RelayWorkflowInput {
  questionId: string;
  askerId: string;
  askerName: string;
  text: string;
  /** Topic the classifier assigned to the question (avoids a second model call). */
  topic: string;
  channel: string;
  threadTs: string;
  teamId: string;
}

interface ConfidenceResult {
  confidence: number;
  answer: string;
  /** Index into the provided decisions list that best supports the answer, or -1. */
  sourceIndex: number;
}

/**
 * The async relay: 25 minutes after a question goes unanswered, either answer it
 * from team memory (if confident) or schedule a briefing DM to the best expert
 * for the start of their next workday.
 */
export async function asyncRelayWorkflow(input: RelayWorkflowInput) {
  "use workflow";
  await sleep("25 minutes");
  await runRelay(input);
}

async function runRelay(input: RelayWorkflowInput): Promise<void> {
  "use step";
  const { createSlackClient } = await import("~/lib/slack/client");
  const { markQuestionAnswered, queryDecisions, recordRelay, whoKnows } =
    await import("~/lib/graph");
  const { generateJson } = await import("~/lib/ai/json");
  const { slackPermalink } = await import("~/lib/slack/utils");
  const {
    resolvePersonTimezone,
    unixSecondsForNextLocalMinuteOfDay,
    WORKDAY_START_MIN,
  } = await import("~/lib/timezone");

  const client = createSlackClient(process.env.SLACK_BOT_TOKEN as string);

  // 1. Someone may have already replied — don't relay a resolved question.
  let humanReplied = false;
  try {
    const res = await client.conversations.replies({
      channel: input.channel,
      ts: input.threadTs,
      limit: 30,
    });
    humanReplied = (res.messages ?? []).some(
      (m) =>
        !m.bot_id &&
        m.user &&
        m.user !== input.askerId &&
        m.ts !== input.threadTs,
    );
  } catch {
    // treat as unanswered
  }
  if (humanReplied) {
    await markQuestionAnswered(input.questionId, input.teamId, 0).catch(
      () => {},
    );
    return;
  }

  // 2. Score how confidently we can answer from stored context.
  const decisions = await queryDecisions(input.topic, input.teamId).catch(
    () => [],
  );
  const context =
    decisions.length > 0
      ? decisions.map((d, i) => `[${i}] ${d.summary}`).join("\n")
      : "(no related decisions found)";
  const scored = await generateJson<ConfidenceResult>(
    `You are Blueprint. An engineer asked a question. Using ONLY the team's stored context below, decide how confidently you can answer it.

Question: "${input.text.replace(/"/g, '\\"')}"

Stored decisions/context (indexed):
${context}

Return ONLY a JSON object:
- "confidence": number 0-1, how confident you are the stored context actually answers the question.
- "answer": if confident, a concise answer grounded in the context (else "").
- "sourceIndex": the index [n] of the decision that best supports the answer, or -1 if none.

Return ONLY valid JSON. No markdown, no code fences.`,
    { confidence: 0, answer: "", sourceIndex: -1 },
    "relay-confidence",
  );

  if (scored.confidence > 0.7 && scored.answer.trim()) {
    const source = decisions[scored.sourceIndex];
    const permalink = source
      ? slackPermalink(source.channel, source.threadTs)
      : null;
    const link = permalink ? ` (source: <${permalink}|prior decision>)` : "";
    await client.chat.postMessage({
      channel: input.channel,
      thread_ts: input.threadTs,
      text: `${scored.answer}${link}`,
    });
    await markQuestionAnswered(
      input.questionId,
      input.teamId,
      scored.confidence,
    );
    return;
  }

  // 3. Low confidence — hand off to the best-qualified person for their 9am.
  const experts = await whoKnows(input.topic, input.teamId).catch(() => []);
  const expert = experts.find((e) => e.personId !== input.askerId);
  if (!expert) {
    await client.chat.postMessage({
      channel: input.channel,
      thread_ts: input.threadTs,
      text: "I couldn't answer this from team memory and don't yet know who owns this area. Someone with context may need to weigh in.",
    });
    return;
  }

  const tz = await resolvePersonTimezone(
    client,
    expert.personId,
    input.teamId,
    expert.personName,
  );
  const threadLink = slackPermalink(input.channel, input.threadTs);

  // Queue a DM to land at 9am the expert's local time.
  try {
    const im = await client.conversations.open({ users: expert.personId });
    const dmChannel = im.channel?.id;
    if (dmChannel) {
      const postAt = tz
        ? unixSecondsForNextLocalMinuteOfDay(tz.tzOffset, WORKDAY_START_MIN)
        : Math.floor(Date.now() / 1000) + 60;
      await client.chat.scheduleMessage({
        channel: dmChannel,
        post_at: postAt,
        text: `☀️ Morning briefing from Blueprint\n\n*${input.askerName}* asked a question in <#${input.channel}> that needs your area of expertise (*${input.topic}*):\n\n> ${input.text}\n\n${threadLink ? `<${threadLink}|Open the thread>` : ""}`,
      });
    }
  } catch (err) {
    console.error("[relay] failed to schedule DM:", err);
  }

  const tzLabel = tz
    ? ` at 9am ${tz.timezone} time`
    : " when they're back online";
  await client.chat.postMessage({
    channel: input.channel,
    thread_ts: input.threadTs,
    text: `I've flagged this for <@${expert.personId}> who handles ${input.topic} — they'll see it${tzLabel}.`,
  });

  await recordRelay({
    questionId: input.questionId,
    toPersonId: expert.personId,
    toPersonName: expert.personName,
    teamId: input.teamId,
    confidence: scored.confidence,
  });
}
