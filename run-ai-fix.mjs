#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));

await loadDotEnv(path.join(scriptDir, ".env"));

const config = {
  githubToken: env("GITHUB_TOKEN"),
  githubApi: stripTrailingSlash(env("GITHUB_API_URL", "https://api.github.com")),
  githubUsername: env("GITHUB_USERNAME", "x-access-token"),
  deepseekApiKey: env("DEEPSEEK_API_KEY"),
  deepseekBaseUrl: stripTrailingSlash(
    env("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
  ),
  deepseekModel: env("DEEPSEEK_MODEL", "deepseek-chat"),
  deepseekMaxTokens: Number(env("DEEPSEEK_MAX_TOKENS", "8000")),
  maxContextChars: Number(env("MAX_CONTEXT_CHARS", "120000")),
  workDir: env("WORK_DIR", path.join(os.tmpdir(), "ai-fix-github-action")),
  gitName: env("GIT_NAME", "ai-fix[bot]"),
  gitEmail: env("GIT_EMAIL", "ai-fix[bot]@users.noreply.github.com"),
};

const ghHeaders = {
  Accept: "application/vnd.github+json",
  "User-Agent": "ai-fix-github-action",
};

function env(name, fallback = "") {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function stripTrailingSlash(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

async function loadDotEnv(file) {
  let content;
  try {
    content = await fs.readFile(file, "utf8");
  } catch {
    return;
  }
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, value] = match;
    let parsed = value.trim();
    if (
      (parsed.startsWith('"') && parsed.endsWith('"')) ||
      (parsed.startsWith("'") && parsed.endsWith("'"))
    ) {
      parsed = parsed.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = parsed;
  }
}

function fail(message) {
  throw new Error(message);
}

function truncate(text, maxLength) {
  const value = String(text ?? "");
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.floor(maxLength * 0.7))}\n...[truncated]...\n${value.slice(-Math.floor(maxLength * 0.3))}`;
}

async function githubApi(pathname, options = {}) {
  const url = `${config.githubApi}${pathname}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      ...ghHeaders,
      Authorization: `Bearer ${config.githubToken}`,
      ...(options.headers ?? {}),
    },
  });
  const bodyText = await response.text();
  if (!response.ok) {
    fail(`GitHub API ${response.status} for ${url}: ${truncate(bodyText, 2000)}`);
  }
  if (!bodyText) return null;
  try {
    return JSON.parse(bodyText);
  } catch {
    fail(`GitHub API returned invalid JSON for ${url}`);
  }
}

async function ghPaged(pathname, perPage = 100) {
  const items = [];
  let page = 1;
  while (true) {
    const separator = pathname.includes("?") ? "&" : "?";
    const url = `${config.githubApi}${pathname}${separator}per_page=${perPage}&page=${page}`;
    const response = await fetch(url, {
      headers: {
        ...ghHeaders,
        Authorization: `Bearer ${config.githubToken}`,
      },
    });
    const body = await response.text();
    if (!response.ok) {
      fail(`GitHub API ${response.status} for ${url}: ${truncate(body, 2000)}`);
    }
    items.push(...JSON.parse(body));
    const link = response.headers.get("link") ?? "";
    const next = link
      .split(",")
      .map((part) => part.trim())
      .find((part) => part.endsWith('rel="next"'));
    if (!next) break;
    page += 1;
    if (page > 20) break;
  }
  return items;
}

async function git(cwd, args, authToken = null) {
  let prefix = [];
  if (authToken) {
    const basic = Buffer.from(`${config.githubUsername}:${authToken}`).toString(
      "base64",
    );
    prefix = [
      "-c",
      "credential.helper=",
      "-c",
      `http.extraheader=AUTHORIZATION: basic ${basic}`,
    ];
  }
  try {
    const result = await execFileAsync("git", [...prefix, ...args], {
      cwd,
      maxBuffer: 50 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "never",
      },
    });
    return result.stdout.trim();
  } catch (error) {
    const detail = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
    fail(`git ${args.join(" ")} failed: ${truncate(detail, 4000)}`);
  }
}

async function prepareCheckout(repoFullName, pullNumber, headSha) {
  const ownerRepo = repoFullName.replace(/\//g, "__");
  const localBranch = `ai-fix-${pullNumber}`;
  const workRoot = path.join(config.workDir, ownerRepo);
  const checkoutDir = path.join(
    workRoot,
    `${pullNumber}-${headSha.slice(0, 12)}`,
  );
  await fs.rm(checkoutDir, { recursive: true, force: true });
  await fs.mkdir(checkoutDir, { recursive: true });

  await git(checkoutDir, ["init", "-q", "-b", "init"]);
  await git(
    checkoutDir,
    ["remote", "add", "origin", `https://github.com/${repoFullName}.git`],
    config.githubToken,
  );
  await git(
    checkoutDir,
    [
      "fetch",
      "--depth",
      "1",
      "origin",
      `+refs/pull/${pullNumber}/head:refs/heads/${localBranch}`,
    ],
    config.githubToken,
  );
  await git(checkoutDir, ["switch", "-f", localBranch]);
  await git(checkoutDir, ["reset", "--hard", "HEAD"]);
  await git(checkoutDir, ["config", "user.name", config.gitName]);
  await git(checkoutDir, ["config", "user.email", config.gitEmail]);
  return checkoutDir;
}

function buildFixPrompt({
  pullRequest,
  triggerComment,
  files,
  reviewComments,
  conversationComments,
  maxChars,
}) {
  const parts = [];
  const triggerText = (triggerComment.body ?? "")
    .replace(/^\s*\/ai-fix\b/i, "")
    .trim();
  parts.push(
    `Repository: ${pullRequest.base.repo.full_name}`,
    `PR #${pullRequest.number}: ${pullRequest.title}`,
    `Target branch: ${pullRequest.head.ref} (${pullRequest.head.sha})`,
    "",
    "PR description:",
    pullRequest.body?.trim() || "(empty)",
    "",
    "Requested action from the /ai-fix comment:",
    triggerText || "Address all review feedback in the PR.",
  );

  if (conversationComments.length > 0) {
    parts.push("", "Relevant PR conversation comments:");
    for (const comment of conversationComments.slice(-30)) {
      parts.push(`- @${comment.user?.login}: ${truncate(comment.body ?? "", 1000)}`);
    }
  }

  if (reviewComments.length > 0) {
    parts.push("", "Inline review comments:");
    for (const comment of reviewComments.slice(-60)) {
      const location = comment.path ? `${comment.path}:${comment.line ?? ""}` : "";
      parts.push(
        `- ${location}`,
        `  Context: ${truncate(comment.diff_hunk ?? "", 1200)}`,
        `  Comment: @${comment.user?.login ?? "reviewer"} ${truncate(comment.body ?? "", 1000)}`,
      );
    }
  }

  parts.push("", "Changed files in this PR (with unified diff hunks):");
  let budget = maxChars;
  for (const file of files) {
    const header = `--- ${file.filename} (${file.status})`;
    const patch = file.patch ? `\n${file.patch}` : "\n(no text diff available)";
    if (header.length + patch.length > budget) {
      parts.push("", "(remaining files omitted because context is too large)");
      break;
    }
    parts.push(header, patch);
    budget -= header.length + patch.length;
  }

  return parts.join("\n");
}

function extractPatch(content) {
  const text = String(content ?? "").trim();
  if (!text) return { summary: "", patch: "" };

  const cleanPatch = (rawPatch) => {
    let patch = String(rawPatch ?? "").trim();
    if (patch.startsWith("```")) {
      patch = patch.replace(/^```[^\n]*\r?\n?/, "").replace(/\r?\n?```\s*$/, "");
    }
    return patch.trim();
  };

  const tryJson = (source) => {
    try {
      const parsed = JSON.parse(source);
      if (parsed && typeof parsed === "object") {
        return {
          summary: String(parsed.summary ?? ""),
          patch: cleanPatch(parsed.patch),
        };
      }
    } catch {
      // Fall through to fence parsing.
    }
    return null;
  };

  const direct = tryJson(text);
  if (direct) return direct;

  const jsonFence = text.match(/```(?:json)?\s*\n?([\s\S]*?)\s*\n?```/i);
  if (jsonFence) {
    const fromFence = tryJson(jsonFence[1]);
    if (fromFence) return fromFence;
  }

  const fenceBlocks = [...text.matchAll(/```[a-zA-Z]*\s*\n?([\s\S]*?)\s*\n?```/g)]
    .map((match) => match[1])
    .filter((block) => block.includes("diff --git"));
  const candidate = fenceBlocks.length > 0 ? fenceBlocks.join("\n") : text;
  const diffStart = candidate.indexOf("diff --git");
  if (diffStart === -1) return { summary: text, patch: "" };

  const lines = candidate.slice(diffStart).split("\n");
  const patchLines = [];
  for (const line of lines) {
    if (
      patchLines.length > 0 &&
      !/^(diff --git|index |--- |\+\+\+ |@@|[-+ \\])/.test(line) &&
      line.trim() !== ""
    ) {
      break;
    }
    patchLines.push(line);
  }
  const patch = cleanPatch(patchLines.join("\n"));
  const prefix = candidate.slice(0, diffStart);
  return {
    summary: truncate(prefix.replace(/[`"'{}[\]]/g, "").trim(), 1000),
    patch,
  };
}

function patchVariants(patch) {
  const variants = [String(patch ?? "")];
  const cleaned = variants[0]
    .split("\n")
    .filter((line) => line.trim() !== "" && !/^```/.test(line))
    .join("\n");
  if (cleaned !== variants[0]) variants.push(cleaned);
  return variants;
}

async function callDeepSeek(prompt) {
  if (!config.deepseekApiKey) fail("DEEPSEEK_API_KEY is not set");
  const systemPrompt = [
    "You are a senior software engineer fixing pull request review comments.",
    "Return ONLY a JSON object with this exact shape:",
    '{"summary": "short human-readable summary", "patch": "complete unified git diff"}',
    "Rules:",
    "- patch must start with 'diff --git' and be valid input for git apply.",
    "- Include every file you changed, with correct context lines.",
    "- Do not add markdown fences, prose outside the JSON, or truncated diffs.",
    "- If no code changes are needed, return a JSON object with an empty patch.",
    "- Inside hunks, every content line must start with exactly one of: a space (context), '-' (removed), '+' (added); never leave empty lines inside a hunk.",
    "- If the requested action is not a code change (for example merging a branch or answering a question), return an empty patch.",
  ].join("\n");
  const response = await fetch(`${config.deepseekBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.deepseekApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.deepseekModel,
      temperature: 0.1,
      max_tokens: config.deepseekMaxTokens,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
    }),
  });
  const bodyText = await response.text();
  if (!response.ok) {
    fail(`DeepSeek API ${response.status}: ${truncate(bodyText, 4000)}`);
  }
  let data;
  try {
    data = JSON.parse(bodyText);
  } catch {
    fail(`DeepSeek API returned invalid JSON: ${truncate(bodyText, 2000)}`);
  }
  const content = data.choices?.[0]?.message?.content ?? "";
  if (!content) fail("DeepSeek API returned an empty response");
  return content;
}

async function applyPatch(checkoutDir, patch) {
  if (!patch.trim()) return false;
  let lastError = null;
  for (const candidate of patchVariants(patch)) {
    if (!candidate.trim()) continue;
    const patchFile = path.join(checkoutDir, ".ai-fix.patch");
    await fs.writeFile(patchFile, candidate, "utf8");
    try {
      await git(checkoutDir, ["apply", "--recount", "--whitespace=nowarn", patchFile]);
      return true;
    } catch (error) {
      lastError = error;
    } finally {
      await fs.rm(patchFile, { force: true });
    }
  }
  throw lastError ?? fail("git apply failed");
}

async function runFix(checkoutDir, prompt) {
  let retried = false;
  let content = await callDeepSeek(prompt);

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const parsed = extractPatch(content);

    if (!parsed.patch.trim()) {
      return { ...parsed, retried };
    }

    console.log(
      `ai-fix: attempt ${attempt} returned a patch of ${parsed.patch.length} chars; summary: ${truncate(parsed.summary || "(none)", 200)}`,
    );
    try {
      await applyPatch(checkoutDir, parsed.patch);
      return { ...parsed, retried };
    } catch (error) {
      console.error(`ai-fix: git apply failed on attempt ${attempt}: ${error.message}`);
      console.error(
        `ai-fix: full model response on attempt ${attempt} was:\n${truncate(content, 8000)}`,
      );
      if (attempt === 2) {
        throw new Error(
          `ai-fix produced a diff that git apply rejected on both attempts. The full model responses are printed in the run log above. Last error: ${error.message}`,
        );
      }
      retried = true;
      const retryPrompt = `${prompt}

Your previous diff did not apply. Correct it and return a new JSON patch that addresses the failure.
git apply error:
${error.message}`;
      content = await callDeepSeek(retryPrompt);
    }
  }

  throw new Error("runFix did not complete");
}

async function commitAndPush(checkoutDir, remoteRef, summary) {
  const status = await git(checkoutDir, ["status", "--porcelain=v1"]);
  if (!status) {
    return { pushed: false, sha: null };
  }
  await git(checkoutDir, ["add", "-A"]);
  await git(
    checkoutDir,
    ["commit", "-m", `ai-fix: ${truncate(summary || "address review comments", 70)}`],
  );
  const sha = await git(checkoutDir, ["rev-parse", "HEAD"]);
  await git(
    checkoutDir,
    ["push", "origin", `HEAD:${remoteRef}`],
    config.githubToken,
  );
  return { pushed: true, sha };
}

async function createIssueComment(repoFullName, issueNumber, body) {
  const [owner, repo] = repoFullName.split("/");
  await githubApi(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  });
}

async function collectContext(owner, repo, pullNumber, triggerCommentId) {
  const pullRequest = await githubApi(
    `/repos/${owner}/${repo}/pulls/${pullNumber}`,
  );
  const [files, reviewComments, conversationComments] = await Promise.all([
    ghPaged(`/repos/${owner}/${repo}/pulls/${pullNumber}/files`),
    ghPaged(`/repos/${owner}/${repo}/pulls/${pullNumber}/comments`),
    ghPaged(`/repos/${owner}/${repo}/issues/${pullNumber}/comments`),
  ]);
  const currentComment = conversationComments.find(
    (comment) => comment.id === triggerCommentId,
  );
  const triggerComment = currentComment ?? { id: 0, body: "/ai-fix", user: {} };
  const botNames = [config.gitName, "ai-fix[bot]"];
  const otherComments = conversationComments.filter(
    (comment) =>
      comment.id !== triggerCommentId &&
      !botNames.includes(comment.user?.login) &&
      !/^\s*\/ai-fix\b/i.test(comment.body ?? ""),
  );
  return {
    pullRequest,
    triggerComment,
    files,
    reviewComments,
    conversationComments: otherComments,
  };
}

async function processPullRequest(repoFullName, pullNumber, commentId) {
  const [owner, repo] = repoFullName.split("/");
  const { pullRequest, triggerComment, files, reviewComments, conversationComments } =
    await collectContext(owner, repo, pullNumber, commentId);

  if (!/^\s*\/ai-fix\b/i.test(triggerComment.body ?? "")) {
    console.log("Comment is not an /ai-fix command, skipping.");
    return;
  }
  if (
    (pullRequest.head?.repo?.full_name ?? "").toLowerCase() !==
    repoFullName.toLowerCase()
  ) {
    fail(
      "PRs from forks are not supported because the workflow token cannot push to the fork",
    );
  }
  if (!pullRequest.head?.sha || !pullRequest.head?.ref) {
    fail("Could not determine PR head sha or branch");
  }

  const checkoutDir = await prepareCheckout(
    repoFullName,
    pullNumber,
    pullRequest.head.sha,
  );
  const prompt = buildFixPrompt({
    pullRequest,
    triggerComment,
    files,
    reviewComments,
    conversationComments,
    maxChars: config.maxContextChars,
  });
  console.log(`Starting ai-fix on ${repoFullName}#${pullNumber}`);

  const fix = await runFix(checkoutDir, prompt);
  const commit = await commitAndPush(
    checkoutDir,
    pullRequest.head.ref,
    fix.summary,
  );

  let result;
  if (commit.pushed) {
    result = `ai-fix complete. Commit: ${commit.sha}`;
  } else if (!fix.patch.trim()) {
    result = "ai-fix complete. DeepSeek made no code changes.";
  } else {
    result = "ai-fix produced changes, but nothing was committed (empty git status).";
  }
  if (fix.summary) result += `\n\n${truncate(fix.summary, 2000)}`;
  await createIssueComment(repoFullName, pullNumber, result);
  console.log(result);
}

async function runFromAction() {
  const repoFullName = env("GITHUB_REPOSITORY");
  const pullNumber = env("PR_NUMBER");
  const commentId = Number(env("COMMENT_ID", "0"));
  if (!config.githubToken) fail("GITHUB_TOKEN is not set");
  if (!repoFullName || !pullNumber) {
    fail("GITHUB_REPOSITORY and PR_NUMBER are required");
  }

  console.log(`Handling PR ${repoFullName}#${pullNumber}`);
  try {
    await processPullRequest(repoFullName, Number(pullNumber), commentId);
  } catch (error) {
    console.error("ai-fix failed:", error);
    try {
      await createIssueComment(
        repoFullName,
        Number(pullNumber),
        `ai-fix failed:\n\n${truncate(error.message, 4000)}`,
      );
    } catch {
      // The run itself is the failure record when commenting is not possible.
    }
    process.exitCode = 1;
  }
}

export {
  buildFixPrompt,
  extractPatch,
  patchVariants,
};

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  runFromAction().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
