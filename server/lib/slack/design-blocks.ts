import type {
  ActionsBlock,
  HeaderBlock,
  InputBlock,
  KnownBlock,
  SectionBlock,
} from "@slack/web-api";
import type {
  ComponentType,
  DesignEnrichment,
  UIComponent,
  UIComponentInput,
  UISpec,
} from "~/lib/ai/design";
import { COMPONENT_TYPES } from "~/lib/ai/design";

// ---------------------------------------------------------------------------
// Action + view identifiers for the collaborative design flow.
// ---------------------------------------------------------------------------
export const DESIGN_COMPONENT_MENU = "design_component_menu"; // overflow: edit / remove
export const DESIGN_ADD_ACTION = "design_add_block";
export const DESIGN_APPROVE_ACTION = "design_approve";
export const DESIGN_EDIT_VIEW = "design_edit_view";
export const DESIGN_ADD_VIEW = "design_add_view";

export type DesignStatus = "draft" | "approved";

/** Marker we stash on the header block so any handler can recover the design id. */
const DESIGN_MARKER = "blueprint_design:";

// ---------------------------------------------------------------------------
// Block Kit limitation note:
// A posted message CANNOT contain real input elements (those only work in modals
// and the App Home). So we MOCK each form field as a styled section block — a
// bold label plus a code-styled placeholder that reads like an empty field — to
// get as close to a real screen as Block Kit allows. Real editing happens in a
// modal (where inputs are allowed) and re-renders the message.
// ---------------------------------------------------------------------------

function mock(c: UIComponent): string {
  switch (c.type) {
    case "header":
      return `*${c.label ?? c.text ?? "Untitled"}*`;
    case "section":
      return c.text ?? c.label ?? "_(empty section)_";
    case "input":
      return `*${c.label ?? "Field"}*${c.required ? "  _(required)_" : ""}\n\`${
        c.placeholder ?? "…"
      }\``;
    case "textarea":
      return `*${c.label ?? "Field"}*${
        c.required ? "  _(required)_" : ""
      }\n\`\`\`${c.placeholder ?? "…"}\`\`\``;
    case "select":
      return `*${c.label ?? "Choose"}*  ⌄\n> ${
        (c.options ?? []).join("  •  ") || "option 1  •  option 2"
      }`;
    case "button":
      return `\`  ${c.label ?? "Button"}  \`${
        c.style === "primary" ? "  ✅" : c.style === "danger" ? "  ⛔" : ""
      }`;
    case "activity":
      return `*${c.label ?? "Activity"}*\n${(c.items ?? [])
        .map((i) => `• ${i}`)
        .join("\n")}`;
    case "image":
      return `🖼  _${c.altText ?? "image"}_`;
    case "divider":
      return "──────────";
    case "context":
      return `_${c.text ?? c.label ?? ""}_`;
    default:
      return "_(unknown component)_";
  }
}

/** One editable component card: the visual mock plus an Edit/Remove overflow. */
function componentBlock(c: UIComponent): SectionBlock {
  return {
    type: "section",
    block_id: `comp_${c.id}`,
    text: { type: "mrkdwn", text: mock(c) },
    accessory: {
      type: "overflow",
      action_id: DESIGN_COMPONENT_MENU,
      options: [
        {
          text: { type: "plain_text", text: "✏️ Edit", emoji: true },
          value: JSON.stringify({ op: "edit", id: c.id }),
        },
        {
          text: { type: "plain_text", text: "🗑️ Remove", emoji: true },
          value: JSON.stringify({ op: "remove", id: c.id }),
        },
      ],
    },
  };
}

function footerActions(designId: string): ActionsBlock {
  return {
    type: "actions",
    block_id: "design_footer",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "➕ Add block", emoji: true },
        action_id: DESIGN_ADD_ACTION,
        value: designId,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "✅ Approve design", emoji: true },
        style: "primary",
        action_id: DESIGN_APPROVE_ACTION,
        value: designId,
      },
    ],
  };
}

/**
 * Render the full design message: header (carrying the design id marker),
 * an enrichment context line, each component as an editable card, and the
 * Add/Approve footer while still a draft.
 */
export function renderDesignBlocks(opts: {
  designId: string;
  title: string;
  spec: UISpec;
  status: DesignStatus;
  enrichment: DesignEnrichment;
}): KnownBlock[] {
  const { designId, title, spec, status, enrichment } = opts;

  const header: HeaderBlock = {
    type: "header",
    block_id: `${DESIGN_MARKER}${designId}`,
    text: { type: "plain_text", text: `🎨 ${title}`, emoji: true },
  };

  const decisionLine =
    enrichment.decisions.length > 0
      ? `${enrichment.decisions.length} related decision(s)`
      : "no prior decisions";
  const expertLine =
    enrichment.experts.length > 0
      ? ` • Experts: ${enrichment.experts
          .slice(0, 3)
          .map((e) => `<@${e.id}>`)
          .join(", ")}`
      : "";

  const blocks: KnownBlock[] = [
    header,
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `${
            status === "approved" ? "✅ Approved design" : "📝 Draft design"
          } • ${decisionLine}${expertLine}`,
        },
      ],
    },
    { type: "divider" },
  ];

  if (spec.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "_Empty design — add a block to start._" },
    });
  } else {
    for (const c of spec) {
      blocks.push(componentBlock(c));
      if (c.type === "image" && c.imageUrl) {
        blocks.push({
          type: "image",
          image_url: c.imageUrl,
          alt_text: c.altText ?? "image",
        });
      }
    }
  }

  blocks.push({ type: "divider" });

  if (status === "approved") {
    blocks.push({
      type: "context",
      elements: [
        { type: "mrkdwn", text: "🔒 This design has been approved and locked." },
      ],
    });
  } else {
    blocks.push(footerActions(designId));
  }

  return blocks;
}

/** Recover the design id from an interaction payload's message blocks. */
export function designIdFromMessage(message: {
  blocks?: Array<{ block_id?: string }>;
}): string | null {
  const header = message.blocks?.find((b) =>
    b.block_id?.startsWith(DESIGN_MARKER),
  );
  return header?.block_id?.slice(DESIGN_MARKER.length) ?? null;
}

// ---------------------------------------------------------------------------
// Modal builders — real input blocks live here (allowed in modals).
// ---------------------------------------------------------------------------

const TYPE_LABELS: Record<ComponentType, string> = {
  header: "Header",
  section: "Text section",
  input: "Text input",
  textarea: "Multi-line input",
  select: "Dropdown",
  button: "Button",
  activity: "Activity list",
  image: "Image",
  divider: "Divider",
  context: "Small helper text",
};

function labelInput(value?: string): InputBlock {
  return {
    type: "input",
    block_id: "label",
    optional: true,
    label: { type: "plain_text", text: "Label / title / button text" },
    element: {
      type: "plain_text_input",
      action_id: "value",
      initial_value: value,
    },
  };
}

function textInput(value?: string): InputBlock {
  return {
    type: "input",
    block_id: "text",
    optional: true,
    label: { type: "plain_text", text: "Body text" },
    element: {
      type: "plain_text_input",
      action_id: "value",
      multiline: true,
      initial_value: value,
    },
  };
}

function placeholderInput(value?: string): InputBlock {
  return {
    type: "input",
    block_id: "placeholder",
    optional: true,
    label: { type: "plain_text", text: "Placeholder" },
    element: {
      type: "plain_text_input",
      action_id: "value",
      initial_value: value,
    },
  };
}

function requiredInput(checked?: boolean): InputBlock {
  return {
    type: "input",
    block_id: "required",
    optional: true,
    label: { type: "plain_text", text: "Required field?" },
    element: {
      type: "checkboxes",
      action_id: "value",
      options: [
        {
          text: { type: "plain_text", text: "Yes, this field is required" },
          value: "required",
        },
      ],
      ...(checked
        ? {
            initial_options: [
              {
                text: {
                  type: "plain_text",
                  text: "Yes, this field is required",
                },
                value: "required",
              },
            ],
          }
        : {}),
    },
  };
}

function listInput(block_id: string, label: string, value?: string): InputBlock {
  return {
    type: "input",
    block_id,
    optional: true,
    label: { type: "plain_text", text: `${label} (one per line)` },
    element: {
      type: "plain_text_input",
      action_id: "value",
      multiline: true,
      initial_value: value,
    },
  };
}

/** Fields relevant to a given component type, prefilled from an existing one. */
function fieldsForType(
  type: ComponentType,
  c?: Partial<UIComponent>,
): InputBlock[] {
  switch (type) {
    case "header":
    case "button":
      return [labelInput(c?.label)];
    case "section":
    case "context":
      return [textInput(c?.text)];
    case "input":
    case "textarea":
      return [
        labelInput(c?.label),
        placeholderInput(c?.placeholder),
        requiredInput(c?.required),
      ];
    case "select":
      return [
        labelInput(c?.label),
        listInput("options", "Options", (c?.options ?? []).join("\n")),
      ];
    case "activity":
      return [
        labelInput(c?.label),
        listInput("items", "Items", (c?.items ?? []).join("\n")),
      ];
    case "image":
      return [
        placeholderInput(c?.imageUrl), // reuse placeholder block for URL
        labelInput(c?.altText),
      ];
    case "divider":
      return [];
    default:
      return [labelInput(c?.label)];
  }
}

/** Modal to edit an existing component. */
export function editComponentModal(opts: {
  designId: string;
  channel: string;
  messageTs: string;
  component: UIComponent;
}) {
  const { designId, channel, messageTs, component } = opts;
  return {
    type: "modal" as const,
    callback_id: DESIGN_EDIT_VIEW,
    private_metadata: JSON.stringify({
      designId,
      channel,
      messageTs,
      componentId: component.id,
      type: component.type,
    }),
    title: { type: "plain_text" as const, text: "Edit component" },
    submit: { type: "plain_text" as const, text: "Save" },
    close: { type: "plain_text" as const, text: "Cancel" },
    blocks: [
      {
        type: "context" as const,
        elements: [
          {
            type: "mrkdwn" as const,
            text: `Editing *${TYPE_LABELS[component.type]}*`,
          },
        ],
      },
      ...fieldsForType(component.type, component),
    ],
  };
}

/** Modal to add a new component: pick a type, fill the fields that apply. */
export function addComponentModal(opts: {
  designId: string;
  channel: string;
  messageTs: string;
}) {
  const { designId, channel, messageTs } = opts;
  return {
    type: "modal" as const,
    callback_id: DESIGN_ADD_VIEW,
    private_metadata: JSON.stringify({ designId, channel, messageTs }),
    title: { type: "plain_text" as const, text: "Add component" },
    submit: { type: "plain_text" as const, text: "Add" },
    close: { type: "plain_text" as const, text: "Cancel" },
    blocks: [
      {
        type: "input" as const,
        block_id: "component_type",
        label: { type: "plain_text" as const, text: "Component type" },
        element: {
          type: "static_select" as const,
          action_id: "value",
          initial_option: {
            text: { type: "plain_text" as const, text: TYPE_LABELS.section },
            value: "section" as ComponentType,
          },
          options: COMPONENT_TYPES.map((t) => ({
            text: { type: "plain_text" as const, text: TYPE_LABELS[t] },
            value: t,
          })),
        },
      },
      {
        type: "context" as const,
        elements: [
          {
            type: "mrkdwn" as const,
            text: "Fill only the fields relevant to your chosen type — the rest are ignored.",
          },
        ],
      },
      labelInput(),
      textInput(),
      placeholderInput(),
      requiredInput(),
      listInput("options", "Dropdown options"),
      listInput("items", "Activity items"),
    ],
  };
}

// ---------------------------------------------------------------------------
// Read component fields back out of a submitted modal (edit or add).
// ---------------------------------------------------------------------------

type ViewValues = Record<
  string,
  Record<
    string,
    {
      value?: string;
      selected_option?: { value: string } | null;
      selected_options?: Array<{ value: string }>;
    }
  >
>;

/** The component type chosen in the add-component modal. */
export function typeFromValues(values: ViewValues): ComponentType {
  const v = values?.component_type?.value?.selected_option?.value;
  return (COMPONENT_TYPES as readonly string[]).includes(v ?? "")
    ? (v as ComponentType)
    : "section";
}

/** Build the type-relevant component fields from submitted modal values. */
export function readComponentFields(
  type: ComponentType,
  values: ViewValues,
): Omit<UIComponentInput, "type"> {
  const text = (b: string) => values?.[b]?.value?.value?.trim() || undefined;
  const list = (b: string) => {
    const raw = text(b);
    return raw
      ? raw
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
  };
  const checked = (b: string) =>
    (values?.[b]?.value?.selected_options?.length ?? 0) > 0;

  switch (type) {
    case "header":
    case "button":
      return { label: text("label") };
    case "section":
    case "context":
      return { text: text("text") };
    case "input":
    case "textarea":
      return {
        label: text("label"),
        placeholder: text("placeholder"),
        required: checked("required"),
      };
    case "select":
      return { label: text("label"), options: list("options") };
    case "activity":
      return { label: text("label"), items: list("items") };
    case "image":
      return { imageUrl: text("placeholder"), altText: text("label") };
    case "divider":
      return {};
    default:
      return { label: text("label") };
  }
}
