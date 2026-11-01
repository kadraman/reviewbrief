import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDiffLines, annotateDiff, anchorFindings } from "./difflines.ts";
import {
  applySeverityPolicy, findingRejectReason, githubReviewPayload, isTypingStyleNit, parseFindingMarker,
  parseResponse, renderFinding, repairFindingsPrompt, reviewOverviewBody, toReviewComment,
} from "./findings.ts";

const DIFF = [
  "diff --git a/a.py b/a.py", "index 111..222 100644", "--- a/a.py", "+++ b/a.py",
  "@@ -1,4 +1,5 @@", " line1", "-old2", "+new2", "+new3", " line3", " line4",
  "@@ -20,2 +21,2 @@", " ctx20", "-gone", "+++ looks like header",
  "diff --git a/new.txt b/new.txt", "new file mode 100644", "--- /dev/null", "+++ b/new.txt",
  "@@ -0,0 +1,2 @@", "+hello", "+world", "\\ No newline at end of file",
  "diff --git a/del.txt b/del.txt", "deleted file mode 100644", "--- a/del.txt", "+++ /dev/null",
  "@@ -1,2 +0,0 @@", "-x", "-y", "",
].join("\n");

const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);
const sig = (o: any) => ({ id: "S", category: "security", severity: "high", confidence: 0.95, file: "a.py", line: 2, title: "t", description: "d", ...o });

test("parseDiffLines maps new-side lines, ignores deletions and '+++' content lines", () => {
  const m = parseDiffLines(DIFF);
  assert.deepEqual(sorted(m.get("a.py")!.added), [2, 3, 22]);
  assert.deepEqual(sorted(m.get("a.py")!.context), [1, 4, 5, 21]);
  assert.deepEqual(sorted(m.get("new.txt")!.added), [1, 2]);
  assert.equal(m.has("del.txt"), false);
});

test("annotateDiff numbers only added/context lines", () => {
  const out = annotateDiff(DIFF.split("diff --git a/new.txt")[0]).split("\n");
  assert.ok(out.includes("    1  line1"));
  assert.ok(out.includes("      -old2"));
  assert.ok(out.includes("    2 +new2"));
  assert.ok(out.some((l) => l.startsWith("   22 +")));
});

test("anchorFindings: valid, invalid line, valid range, cross-hunk range drops suggestion", () => {
  const m = parseDiffLines(DIFF);
  const r = anchorFindings([
    sig({ line: 2 }), sig({ line: 99 }), sig({ file: "nope.py" }),
    sig({ line: 2, endLine: 4, suggestion: "x" }), sig({ line: 5, endLine: 21, suggestion: "y" }), sig({ file: "./a.py", line: 22 }),
  ] as any, m);
  assert.equal(r.anchored.length, 4);
  assert.equal(r.unanchored.length, 2);
  assert.equal(r.anchored[1].endLine, 4);
  assert.equal(r.anchored[2].endLine, undefined);
  assert.equal(r.anchored[2].suggestion, undefined);
  assert.equal(r.anchored[3].file, "a.py");
});

test("range comments carry start_line", () => {
  const c = toReviewComment(sig({ line: 2, endLine: 4 }) as any, "b");
  assert.deepEqual([c.start_line, c.line, c.start_side], [2, 4, "RIGHT"]);
  assert.equal("start_line" in toReviewComment(sig({ line: 2 }) as any, "b"), false);
});

test("parseResponse: prose is not ok, empty array is ok, array recommendation survives rendering", () => {
  assert.equal(parseResponse("Looks fine overall.").ok, false);
  assert.deepEqual(parseResponse('{"findings": []}'), { ok: true, findings: [], dropped: 0, rejected: [] });
  const r = parseResponse('```json\n{"findings":[{"id":1,"category":"Security","severity":"HIGH","confidence":"85%","file":"a.py","line":"2","title":"t","description":"d","recommendation":["do A","do B"]},{"bad":true}]}\n```');
  assert.equal(r.ok, true); assert.equal(r.dropped, 1); assert.equal(r.findings.length, 1);
  assert.equal(r.rejected.length, 1);
  assert.match(r.rejected[0].reason, /category/);
  assert.equal(r.findings[0].line, 2); assert.equal(r.findings[0].level, "high"); assert.equal(r.findings[0].confidence, 0.75);
  assert.equal(r.findings[0].recommendation, "do A do B");
  assert.doesNotThrow(() => renderFinding(r.findings[0]));
});

test("findingRejectReason and repairFindingsPrompt describe schema failures", () => {
  assert.equal(findingRejectReason({
    category: "security", severity: "high", file: "a.py", line: 1, title: "t", description: "d",
  }), null);
  assert.match(findingRejectReason({ category: "bug", severity: "high", file: "a.py", line: 1, title: "t", description: "d" }) ?? "", /category/);
  assert.match(findingRejectReason({ category: "security", severity: "high", file: "a.py", line: "x", title: "t", description: "d" }) ?? "", /line/);
  const prompt = repairFindingsPrompt([{
    index: 0, reason: "line must be a positive integer (got \"x\")",
    row: { category: "security", severity: "high", file: "a.py", line: "x", title: "t", description: "d" },
  }]);
  assert.match(prompt, /Rejected items/);
  assert.match(prompt, /line must be a positive integer/);
  assert.match(prompt, /Do NOT resend the findings that were already accepted/);
});

test("applySeverityPolicy promotes removed dirty/unsaved-draft guards to high", () => {
  const med = applySeverityPolicy(sig({
    severity: "medium", confidence: 0.9, title: "Dirty-draft navigation guard removed",
    description: "selectInstrument no longer prompts on unsaved draft changes.",
  }) as any);
  assert.equal(med.severity, "high");
  const other = applySeverityPolicy(sig({
    severity: "medium", title: "Loop listener may re-enter", description: "Idempotency concern.",
  }) as any);
  assert.equal(other.severity, "medium");
  const parsed = parseResponse(JSON.stringify({
    findings: [{
      id: "1", category: "quality", severity: "medium", confidence: "high", file: "a.ts", line: 1,
      title: "Dirty guard removed from instrument picker", description: "No longer checks unsaved draft.",
      evidence: "setSelected(name)",
    }],
  }));
  assert.equal(parsed.findings[0].severity, "high");
});

test("TypeScript any / type-assertion nits are rejected", () => {
  assert.equal(isTypingStyleNit("Use of `any` for rawAst parameter", "Parameter is typed as any."), true);
  assert.equal(isTypingStyleNit("Dirty draft guard removed", "Users can lose unsaved edits."), false);
  assert.match(findingRejectReason({
    category: "quality", severity: "medium", file: "a.ts", line: 1,
    title: "Use of `any` for channels map", description: "channels is typed as any.",
  }) ?? "", /typing\/style nit/);
  const parsed = parseResponse(JSON.stringify({
    findings: [
      { id: "1", category: "quality", severity: "medium", confidence: "high", file: "a.ts", line: 1,
        title: "Use of `any` for x", description: "typed as any", evidence: "const x: any = 1" },
      { id: "2", category: "security", severity: "high", confidence: "high", file: "a.ts", line: 2,
        title: "SQL injection", description: "user input in query", evidence: "db.query(user)" },
    ],
  }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.findings[0].title, "SQL injection");
  assert.equal(parsed.dropped, 1);
  assert.match(parsed.rejected[0].reason, /typing\/style nit/);
});

test("CRLF diffs match LF line maps and annotate blank context", () => {
  const lf = [
    "diff --git a/a.py b/a.py", "--- a/a.py", "+++ b/a.py",
    "@@ -1,3 +1,3 @@", " keep", "", "+added",
  ].join("\n");
  const crlf = lf.replace(/\n/g, "\r\n");
  const lfMap = parseDiffLines(lf);
  const crlfMap = parseDiffLines(crlf);
  assert.deepEqual(sorted(lfMap.get("a.py")!.added), sorted(crlfMap.get("a.py")!.added));
  assert.deepEqual(sorted(lfMap.get("a.py")!.context), sorted(crlfMap.get("a.py")!.context));
  assert.ok(annotateDiff(crlf).includes("    2  "));
});

test("anchorFindings drops absurd endLine without hanging", () => {
  const m = parseDiffLines(DIFF);
  const started = Date.now();
  const r = anchorFindings([sig({ line: 2, endLine: 2_147_483_647, suggestion: "x" }) as any], m);
  assert.ok(Date.now() - started < 1_000);
  assert.equal(r.anchored.length, 1);
  assert.equal(r.anchored[0].endLine, undefined);
  assert.equal(r.anchored[0].suggestion, undefined);
});

test("renderFinding picks a fence longer than any backtick run in the suggestion", () => {
  const body = renderFinding(sig({ suggestion: "use ````code```` here" }) as any, 2000);
  assert.match(body, /\n`````suggestion\n/);
  assert.match(body, /\n`````\n/);
});

test("renderFinding uses Copilot-style severity, omits confidence %, and keeps a marker", () => {
  const body = renderFinding(sig({
    id: "RB1",
    title: "Truthiness bug",
    description: "`token.pan` of `0` is ignored.",
    recommendation: "Use an explicit `!== undefined` check.",
  }) as any, 2000);
  assert.match(body, /<div align="right"><b>High<\/b><\/div>/);
  assert.match(body, /\*\*Truthiness bug\*\*/);
  assert.match(body, /token\.pan/);
  assert.match(body, /\*\*Fix:\*\* Use an explicit/);
  assert.doesNotMatch(body, /% confidence/);
  assert.doesNotMatch(body, /🚨|⚠️/);
  assert.equal(parseFindingMarker(body), "RB1");
});

test("renderFinding keeps a short suggestion by shrinking long prose first", () => {
  const longDesc = "D".repeat(900);
  const body = renderFinding(sig({
    description: longDesc,
    recommendation: "Pin to a commit SHA.",
    suggestion: "uses: kadraman/reviewbrief@abc123",
  }) as any, 800);
  assert.match(body, /```suggestion\nuses: kadraman\/reviewbrief@abc123\n```/);
  assert.doesNotMatch(body, /Suggestion omitted/);
  assert.ok(body.length <= 800);
  // Long prose was compressed (not left intact) so the suggestion could stay.
  assert.ok(!body.includes(longDesc));
  assert.match(body, /D…/);
  assert.equal(parseFindingMarker(body), "S");
});

test("renderFinding omits only when the suggestion block itself cannot fit", () => {
  const huge = Array.from({ length: 40 }, (_, i) => `line_${i}_xxxxxxxxxxxxxxxx`).join("\n");
  const body = renderFinding(sig({
    description: "Short problem statement.",
    recommendation: "Rewrite the block.",
    suggestion: huge,
  }) as any, 800);
  assert.match(body, /Suggestion omitted/);
  assert.doesNotMatch(body, /```suggestion/);
  assert.match(body, /Short problem statement/);
  assert.ok(body.length <= 800);
  assert.equal(parseFindingMarker(body), "S");
});

test("review overview body uses Copilot-style sections; below-gate stay off the PR", () => {
  const empty = reviewOverviewBody([], 0.85);
  assert.match(empty, /## Pull request overview/);
  assert.match(empty, /No inline findings met the publish gate/);
  assert.doesNotMatch(empty, /Also noted/);
  const emptyWithBelow = reviewOverviewBody([], 0.85, { belowGateCount: 3 });
  assert.match(emptyWithBelow, /3 other findings were scored but stayed below the publish gate/);
  const body = reviewOverviewBody([
    sig({ severity: "high", title: "CRLF blank context", file: "scripts/difflines.ts", line: 34 }),
    sig({ severity: "critical", confidence: 0.95, title: "Fence length", file: "scripts/findings.ts", line: 128 }),
  ] as any, 0.85, {
    title: "Fix CRLF and fence length",
    body: "This PR hardens the diff parser.\n\n## Changes\n- Fix CRLF context\n- Fix fence length\n",
    files: [
      { path: "scripts/difflines.ts", reviewed: true, comments: 1 },
      { path: "scripts/findings.ts", reviewed: true, comments: 1 },
      { path: "other.py", reviewed: false, comments: 0, note: "not on reviewed diff" },
    ],
    unanchored: [sig({
      confidence: 0.9, title: "Unanchored high", file: "other.py", line: 1,
      description: "Cannot attach this line.", recommendation: "Move the change onto an added line.",
    }) as any],
  });
  assert.match(body, /## Pull request overview/);
  assert.match(body, /Fix CRLF and fence length/);
  assert.match(body, /This PR hardens the diff parser\./);
  assert.match(body, /\*\*Changes:\*\*/);
  assert.match(body, /- Fix CRLF context/);
  assert.match(body, /ReviewBrief reviewed 2 out of 3 changed files/);
  assert.match(body, /generated 2 comments/);
  assert.match(body, /Show a summary per file/);
  assert.match(body, /`scripts\/difflines\.ts`: reviewed, 1 comment/);
  assert.doesNotMatch(body, /\| Severity \| Count \|/);
  assert.doesNotMatch(body, /confidence ≥/);
  assert.match(body, /### Could not place inline/);
  assert.match(body, /\*\*Unanchored high\*\*/);
  assert.match(body, /Cannot attach this line\./);
  assert.match(body, /\*\*Recommendation:\*\* Move the change onto an added line\./);
  assert.doesNotMatch(body, /Also noted/);
  const payload = githubReviewPayload([
    sig({ confidence: 0.9, title: "Keep" }),
    sig({ confidence: 0.5, title: "Drop" }),
    sig({ severity: "low", confidence: 0.95, title: "Low severity drop" }),
    sig({ severity: "medium", confidence: 0.99, title: "Medium never inline" }),
  ] as any, 0.85, undefined, undefined, [
    sig({ file: "other.py", line: 1, title: "Unanchored high", confidence: 0.9, description: "d", recommendation: "fix it" }) as any,
    sig({ file: "other.py", line: 2, title: "Unanchored medium", severity: "medium", confidence: 0.99, description: "skip" }) as any,
  ], false, {
    title: "Keep the gate",
    files: [{ path: "a.py", reviewed: true, comments: 1 }],
  });
  assert.match(payload.body, /## Pull request overview/);
  assert.match(payload.body, /generated 1 comment/);
  assert.doesNotMatch(payload.body, /\*\*Keep\*\*/); // findings live on inline threads, not the overview list
  assert.doesNotMatch(payload.body, /Also noted/);
  assert.doesNotMatch(payload.body, /\*\*Drop\*\*/);
  assert.doesNotMatch(payload.body, /\*\*Low severity drop\*\*/);
  assert.doesNotMatch(payload.body, /\*\*Medium never inline\*\*/);
  assert.doesNotMatch(payload.body, /\*\*Unanchored medium\*\*/);
  assert.match(payload.body, /### Could not place inline/);
  assert.match(payload.body, /\*\*Unanchored high\*\*/);
  assert.match(payload.body, /\*\*Recommendation:\*\* fix it/);
  assert.equal(payload.comments.length, 1);
  assert.match(payload.comments[0].body, /<div align="right"><b>High<\/b><\/div>/);
  assert.doesNotMatch(payload.comments[0].body, /% confidence/);
  const capped = githubReviewPayload([
    sig({ confidence: 0.95, title: "First", line: 2 }),
    sig({ confidence: 0.9, title: "Second", line: 3, description: "Over cap.", recommendation: "Raise the cap." }),
  ] as any, 0.85, 1);
  assert.equal(capped.comments.length, 1);
  assert.match(capped.body, /### Over the inline cap/);
  assert.match(capped.body, /\*\*Second\*\*/);
  assert.match(capped.body, /\*\*Recommendation:\*\* Raise the cap\./);
});