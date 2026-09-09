import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildFixPrompt,
  extractPatch,
  patchVariants,
} from "../run-ai-fix.mjs";

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

test("patchVariants keeps the original patch first", () => {
  const patch = "diff --git a/x b/x\nindex a..b 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new";
  const variants = patchVariants(patch);
  assert.equal(variants[0], patch);
  assert.equal(variants.length, 1);
});

test("patchVariants drops empty and fence lines", () => {
  const patch = [
    "diff --git a/x b/x",
    "index a..b 100644",
    "--- a/x",
    "+++ b/x",
    "@@ -1,3 +1,3 @@",
    "-old",
    "",
    "```diff",
    "+new",
  ].join("\n");
  const variants = patchVariants(patch);
  assert.ok(variants.length >= 2);
  const cleaned = variants[variants.length - 1].split("\n");
  assert.ok(!cleaned.includes(""));
  assert.ok(!cleaned.some((line) => line.startsWith("```")));
});
