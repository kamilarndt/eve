#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildAnsweredBlocks,
  renderInputRequestBlocks,
} from "../src/public/channels/slack/hitl.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(SCRIPT_DIR, "..");
const REPO_DIR = resolve(PACKAGE_DIR, "../..");
const OUTPUT_DIR = resolve(REPO_DIR, ".eve/artifacts/slack-hitl");
const BEFORE_FIX_OUTPUT_DIR = join(OUTPUT_DIR, "before-fix");
const CHROME_BIN = findChrome();

const fixedBeforeBlocks = [
  ...renderInputRequestBlocks(
    makeApprovalRequest({
      issueId: "451",
      requestId: "approval_451",
      slackUserId: "U0AT7H56S90",
    }),
  ),
  ...renderInputRequestBlocks(makeApprovalRequest({ issueId: "508", requestId: "approval_508" })),
];

const fixedAfterBlocks = [
  answerCardBlock({
    answerLabel: "Allow",
    block: fixedBeforeBlocks[0],
    userId: "U0AT7H56S90",
  }),
  ...fixedBeforeBlocks.slice(1),
];

const legacyBeforeBlocks = [
  ...renderLegacyInputRequestBlocks(
    makeApprovalRequest({
      issueId: "451",
      requestId: "approval_451",
      slackUserId: "U0AT7H56S90",
    }),
  ),
  ...renderLegacyInputRequestBlocks(
    makeApprovalRequest({ issueId: "508", requestId: "approval_508" }),
  ),
];

// Pre-fix, Slack chat.update replaced the whole message with only the
// answered state. The sibling request blocks were dropped.
const legacyAfterBlocks = buildAnsweredBlocks({
  promptBlocks: [],
  answerLabel: "Approve",
  userId: "U0AT7H56S90",
});

await mkdir(OUTPUT_DIR, { recursive: true });
await mkdir(BEFORE_FIX_OUTPUT_DIR, { recursive: true });
await writeJson(OUTPUT_DIR, "01-before-click.blocks.json", fixedBeforeBlocks);
await writeJson(OUTPUT_DIR, "02-after-first-click.blocks.json", fixedAfterBlocks);
await writeJson(BEFORE_FIX_OUTPUT_DIR, "01-before-click.blocks.json", legacyBeforeBlocks);
await writeJson(BEFORE_FIX_OUTPUT_DIR, "02-after-first-click.blocks.json", legacyAfterBlocks);

const pendingHtmlPath = await writeHtml(OUTPUT_DIR, "01-before-click.html", {
  blocks: fixedBeforeBlocks,
  eyebrow: "Before click",
  title: "Two pending HITL approvals",
});
const answeredHtmlPath = await writeHtml(OUTPUT_DIR, "02-after-first-click.html", {
  blocks: fixedAfterBlocks,
  eyebrow: "After clicking Allow on issue 451",
  title: "Sibling approval remains clickable",
});
const legacyPendingHtmlPath = await writeHtml(BEFORE_FIX_OUTPUT_DIR, "01-before-click.html", {
  blocks: legacyBeforeBlocks,
  eyebrow: "Before fix, before click",
  title: "Two pending HITL approvals",
});
const legacyAnsweredHtmlPath = await writeHtml(BEFORE_FIX_OUTPUT_DIR, "02-after-first-click.html", {
  blocks: legacyAfterBlocks,
  eyebrow: "Before fix, after clicking Approve on issue 451",
  title: "Sibling approval buttons disappear",
});

const pendingPngPath = join(OUTPUT_DIR, "01-before-click.png");
const answeredPngPath = join(OUTPUT_DIR, "02-after-first-click.png");
const legacyPendingPngPath = join(BEFORE_FIX_OUTPUT_DIR, "01-before-click.png");
const legacyAnsweredPngPath = join(BEFORE_FIX_OUTPUT_DIR, "02-after-first-click.png");

captureScreenshot({ htmlPath: pendingHtmlPath, pngPath: pendingPngPath });
captureScreenshot({ htmlPath: answeredHtmlPath, pngPath: answeredPngPath });
captureScreenshot({ htmlPath: legacyPendingHtmlPath, pngPath: legacyPendingPngPath });
captureScreenshot({ htmlPath: legacyAnsweredHtmlPath, pngPath: legacyAnsweredPngPath });

console.log(`Wrote Slack HITL screenshots to ${OUTPUT_DIR}`);
console.log(`- ${pendingPngPath}`);
console.log(`- ${answeredPngPath}`);
console.log(`Wrote before-fix Slack HITL screenshots to ${BEFORE_FIX_OUTPUT_DIR}`);
console.log(`- ${legacyPendingPngPath}`);
console.log(`- ${legacyAnsweredPngPath}`);

function makeApprovalRequest(input) {
  const toolInput =
    input.slackUserId === undefined
      ? { issue: Number(input.issueId) }
      : { issue: Number(input.issueId), userId: input.slackUserId };

  return {
    requestId: input.requestId,
    prompt: "Approve `escalate_issue`?",
    display: "confirmation",
    action: {
      callId: `escalate_issue_${input.issueId}`,
      input: toolInput,
      name: "escalate_issue",
    },
    options: [
      { id: "approve", label: "Approve", style: "primary" },
      { id: "deny", label: "Deny", style: "danger" },
    ],
  };
}

function removeCardActions(block) {
  if (!isRecord(block) || block.type !== "card") return block;

  const { actions: _actions, ...blockWithoutActions } = block;
  return blockWithoutActions;
}

function answerCardBlock(input) {
  const blockWithoutActions = removeCardActions(input.block);
  if (!isRecord(blockWithoutActions)) return blockWithoutActions;

  return {
    ...blockWithoutActions,
    subtext: {
      type: "mrkdwn",
      text: `:white_check_mark: *${input.answerLabel}* by <@${input.userId}>`,
      verbatim: false,
    },
  };
}

function renderLegacyInputRequestBlocks(request) {
  const prompt = {
    text: { text: request.prompt, type: "mrkdwn" },
    type: "section",
  };
  const details = legacyToolInputDetails(request);
  const detailBlocks =
    details === undefined ? [] : [{ type: "section", text: { type: "mrkdwn", text: details } }];
  const actionId = `eve_input:${request.requestId}`;

  return [
    prompt,
    ...detailBlocks,
    {
      type: "actions",
      elements: request.options.map((option, index) => ({
        action_id: `${actionId}:button:${index}`,
        text: { text: option.label, type: "plain_text" },
        type: "button",
        value: option.id,
        ...(option.style === "primary" || option.style === "danger" ? { style: option.style } : {}),
      })),
    },
  ];
}

function legacyToolInputDetails(request) {
  const json = JSON.stringify(request.action.input, null, 2);
  if (json === "{}") return undefined;
  return `*Tool input*\n\`\`\`\n${json}\n\`\`\``;
}

async function writeJson(outputDir, fileName, value) {
  await writeFile(join(outputDir, fileName), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeHtml(outputDir, fileName, input) {
  const htmlPath = join(outputDir, fileName);
  await writeFile(htmlPath, renderPage(input), "utf8");
  return htmlPath;
}

function captureScreenshot(input) {
  execFileSync(
    CHROME_BIN,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=920,820",
      `--screenshot=${input.pngPath}`,
      pathToFileURL(input.htmlPath).href,
    ],
    { stdio: "ignore" },
  );
}

function renderPage(input) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${escapeHtml(input.title)}</title>
    <style>
      :root {
        color-scheme: light;
        font-family: Arial, Helvetica, sans-serif;
        background: #f8f8f8;
        color: #1d1c1d;
      }

      body {
        margin: 0;
        padding: 32px;
      }

      .stage {
        width: 820px;
        margin: 0 auto;
      }

      .caption {
        margin-bottom: 18px;
      }

      .eyebrow {
        color: #616061;
        font-size: 13px;
        font-weight: 700;
        margin-bottom: 6px;
        text-transform: uppercase;
      }

      h1 {
        font-size: 24px;
        letter-spacing: 0;
        line-height: 1.2;
        margin: 0;
      }

      .slack {
        background: #ffffff;
        border: 1px solid #dddddd;
        box-shadow: 0 12px 32px rgb(0 0 0 / 8%);
        padding: 24px;
      }

      .message {
        display: grid;
        gap: 12px;
        grid-template-columns: 38px minmax(0, 1fr);
      }

      .avatar {
        align-items: center;
        background: #4a154b;
        color: #ffffff;
        display: flex;
        font-size: 16px;
        font-weight: 800;
        height: 36px;
        justify-content: center;
        width: 36px;
      }

      .meta {
        align-items: baseline;
        display: flex;
        gap: 8px;
        margin-bottom: 10px;
      }

      .name {
        font-size: 15px;
        font-weight: 800;
      }

      .time {
        color: #616061;
        font-size: 12px;
      }

      .blocks {
        display: grid;
        gap: 10px;
        max-width: 620px;
      }

      .card {
        border: 1px solid #d0d0d0;
        border-radius: 8px;
        overflow: hidden;
      }

      .container {
        border: 1px solid #d0d0d0;
        border-radius: 8px;
        overflow: hidden;
      }

      .container-title {
        align-items: center;
        background: #fafafa;
        border-bottom: 1px solid #e8e8e8;
        display: flex;
        font-size: 14px;
        font-weight: 800;
        gap: 8px;
        padding: 10px 14px;
      }

      .container-title::before {
        color: #616061;
        content: "⌄";
        font-size: 15px;
      }

      .container-children {
        display: grid;
        gap: 0;
      }

      .card-body,
      .card-subtext,
      .section,
      .context {
        font-size: 15px;
        line-height: 1.45;
        padding: 12px 14px;
      }

      .card-subtext {
        border-top: 1px solid #e8e8e8;
        color: #616061;
      }

      .card-actions,
      .actions {
        border-top: 1px solid #e8e8e8;
        display: flex;
        gap: 8px;
        padding: 10px 12px;
      }

      .button {
        background: #ffffff;
        border: 1px solid #c9c9c9;
        border-radius: 4px;
        color: #1d1c1d;
        font-size: 13px;
        font-weight: 700;
        min-width: 72px;
        padding: 7px 12px;
      }

      .button.primary {
        background: #007a5a;
        border-color: #007a5a;
        color: #ffffff;
      }

      .button.danger {
        border-color: #e01e5a;
        color: #e01e5a;
      }

      .context {
        color: #616061;
        font-size: 13px;
        padding-top: 0;
      }

      code {
        background: #f2f2f2;
        border: 1px solid #e0e0e0;
        border-radius: 4px;
        font-family: "SFMono-Regular", Consolas, monospace;
        font-size: 0.92em;
        padding: 1px 4px;
      }

      pre {
        background: #f8f8f8;
        border: 1px solid #dddddd;
        border-radius: 6px;
        margin: 8px 0 0;
        overflow: hidden;
        padding: 10px;
        white-space: pre-wrap;
      }

      pre code {
        background: transparent;
        border: 0;
        padding: 0;
      }

      .mention {
        background: #e8f5fa;
        border-radius: 3px;
        color: #1264a3;
        font-weight: 700;
        padding: 1px 3px;
      }

      .status-check {
        color: #007a5a;
        font-weight: 800;
      }
    </style>
  </head>
  <body>
    <main class="stage">
      <section class="caption">
        <div class="eyebrow">${escapeHtml(input.eyebrow)}</div>
        <h1>${escapeHtml(input.title)}</h1>
      </section>
      <section class="slack" aria-label="Slack message preview">
        <div class="message">
          <div class="avatar">e0</div>
          <div>
            <div class="meta">
              <span class="name">e0</span>
              <span class="time">Today at 2:31 PM</span>
            </div>
            <div class="blocks">
              ${input.blocks.map(renderBlock).join("\n")}
            </div>
          </div>
        </div>
      </section>
    </main>
  </body>
</html>
`;
}

function renderBlock(block) {
  if (!isRecord(block)) return "";

  if (block.type === "card") {
    const body = isRecord(block.body) && typeof block.body.text === "string" ? block.body.text : "";
    const actions = Array.isArray(block.actions) ? block.actions : [];
    return `<article class="card">
  <div class="card-body">${renderMrkdwn(body)}</div>
  ${renderCardSubtext(block)}
  ${actions.length > 0 ? `<div class="card-actions">${actions.map(renderButton).join("")}</div>` : ""}
</article>`;
  }

  if (block.type === "container") {
    const title =
      isRecord(block.title) && typeof block.title.text === "string" ? block.title.text : "";
    const childBlocks = Array.isArray(block.child_blocks) ? block.child_blocks : [];
    return `<article class="container">
  <div class="container-title">${escapeHtml(title)}</div>
  <div class="container-children">${childBlocks.map(renderBlock).join("")}</div>
</article>`;
  }

  if (block.type === "section") {
    const text = isRecord(block.text) && typeof block.text.text === "string" ? block.text.text : "";
    return `<div class="section">${renderMrkdwn(text)}</div>`;
  }

  if (block.type === "context") {
    const elements = Array.isArray(block.elements) ? block.elements : [];
    return `<div class="context">${elements.map(renderContextElement).join(" ")}</div>`;
  }

  if (block.type === "actions") {
    const elements = Array.isArray(block.elements) ? block.elements : [];
    return `<div class="actions">${elements.map(renderButton).join("")}</div>`;
  }

  return "";
}

function renderCardSubtext(block) {
  if (!isRecord(block.subtext) || typeof block.subtext.text !== "string") return "";
  return `<div class="card-subtext">${renderMrkdwn(block.subtext.text)}</div>`;
}

function renderContextElement(element) {
  if (!isRecord(element) || typeof element.text !== "string") return "";
  return renderMrkdwn(element.text);
}

function renderButton(button) {
  if (!isRecord(button)) return "";

  const text =
    isRecord(button.text) && typeof button.text.text === "string" ? button.text.text : "";
  const styleClass =
    button.style === "primary" ? " primary" : button.style === "danger" ? " danger" : "";

  return `<button class="button${styleClass}" type="button">${escapeHtml(text)}</button>`;
}

function renderMrkdwn(value) {
  return String(value)
    .split("```")
    .map((chunk, index) =>
      index % 2 === 1 ? `<pre><code>${escapeHtml(chunk.trim())}</code></pre>` : renderInline(chunk),
    )
    .join("");
}

function renderInline(value) {
  return escapeHtml(value)
    .replaceAll(/&lt;@([A-Z0-9]+)&gt;/gu, '<span class="mention">@$1</span>')
    .replaceAll(":white_check_mark:", '<span class="status-check">&#10003;</span>')
    .replaceAll(/`([^`]+)`/gu, "<code>$1</code>")
    .replaceAll(/\*([^*\n]+)\*/gu, "<strong>$1</strong>")
    .replaceAll(/\n/gu, "<br>");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    which("google-chrome"),
    which("chromium"),
    which("chromium-browser"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  throw new Error(
    "Could not find Chrome. Install Google Chrome or rerun with CHROME_BIN=/path/to/chrome.",
  );
}

function which(binaryName) {
  try {
    return execFileSync("/usr/bin/env", ["which", binaryName], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}
