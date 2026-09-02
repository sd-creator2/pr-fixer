import assert from "node:assert/strict";
import { test } from "node:test";
import crypto from "node:crypto";
import {
  buildFixPrompt,
  extractPatch,
  verifyWebhookSignature,
} from "../index.js";

test("extractPatch parses plain JSON responses", () => {
  const patch = [
    "diff --git a/a.js b/a.js",
    "index 1111111..2222222 100644",
    "--- a/a.js",
    "+++ b/a.js",
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ].join("\n");
  const output = extractPatch(
    JSON.stringify({ summary: "fixed it", patch }),
  );
  assert.equal(output.summary, "fixed it");
  assert.equal(output.patch, patch);
});

test("extractPatch handles a diff inside markdown fences", () => {
  const output = extractPatch([
    "Summary: rename variable.",
    "```diff",
    "diff --git a/a.js b/a.js",
    "index 1111111..2222222 100644",
    "--- a/a.js",
    "+++ b/a.js",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "```",
  ].join("\n"));
  assert.match(output.patch, /^diff --git a\/a\.js b\/a\.js/);
  assert.match(output.patch, /\+new/);
});

test("extractPatch cleans a diff that was embedded in JSON with fences", () => {
  const output = extractPatch(
    JSON.stringify({
      summary: "fix formatting",
      patch: [
        "```diff",
        "diff --git a/a.js b/a.js",
        "index 1111111..2222222 100644",
        "--- a/a.js",
        "+++ b/a.js",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "```",
      ].join("\n"),
    }),
  );
  assert.match(output.patch, /^diff --git a\/a\.js b\/a\.js/);
  assert.doesNotMatch(output.patch, /```/);
});

test("buildFixPrompt includes review feedback and changed files", () => {
  const prompt = buildFixPrompt({
    pullRequest: {
      number: 12,
      title: "Add login",
      body: "New endpoint",
      base: { repo: { full_name: "acme/web" } },
      head: { ref: "feature/login", sha: "abc123" },
    },
    triggerComment: { body: "/ai-fix add validation" },
    files: [
      {
        filename: "server.js",
        status: "modified",
        patch: "@@ -1 +1 @@\n-old\n+new",
      },
    ],
    reviewComments: [
      {
        path: "server.js",
        line: 3,
        diff_hunk: "@@ -3 +3 @@",
        body: "Validate the input",
        user: { login: "reviewer" },
      },
    ],
    conversationComments: [],
    maxChars: 200000,
  });
  assert.match(prompt, /PR #12/);
  assert.match(prompt, /Validate the input/);
  assert.match(prompt, /server\.js \(modified\)/);
});

test("verifyWebhookSignature compares SHA-256 signatures", () => {
  const body = Buffer.from('{"ok":true}');
  const valid =
    "sha256=" +
    crypto.createHmac("sha256", "secret").update(body).digest("hex");
  assert.equal(verifyWebhookSignature("secret", body, valid), true);
  assert.equal(verifyWebhookSignature("secret", body, "sha256=wrong"), false);
  assert.equal(verifyWebhookSignature("", body, valid), false);
});
