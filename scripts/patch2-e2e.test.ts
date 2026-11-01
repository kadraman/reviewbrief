import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(ROOT, "reviewbrief.ts");

// a.py new-file lines: 1 context "import os", 2 "def run(cmd):", 3 "    os.system(cmd)", 4 "    return True", 5 context "# end"
const DIFF = [
  "diff --git a/a.py b/a.py", "index 111..222 100644", "--- a/a.py", "+++ b/a.py",
  "@@ -1,2 +1,5 @@", " import os", "+def run(cmd):", "+    os.system(cmd)", "+    return True", " # end",
].join("\n");
const LOCKFILE_DIFF = ["diff --git a/package-lock.json b/package-lock.json", "--- a/package-lock.json", "+++ b/package-lock.json", "@@ -1 +1 @@", "-a", "+b"].join("\n");

const finding = (o: Record<string, unknown> = {}) => ({
  id: "S", category: "security", severity: "high", confidence: "high", file: "a.py", line: 3,
  title: "t", description: "d", evidence: "os.system(cmd)", ...o,
});
const findingsJson = (...findings: unknown[]) => JSON.stringify({ findings });

type Reply = { status: number; content?: string; message?: string };
type RequestBody = { temperature?: number; messages?: { role: string; content: string }[] };

async function withMock(handler: (call: number, body: RequestBody) => Reply, run: (baseUrl: string, seen: RequestBody[]) => Promise<void>): Promise<void> {
  const seen: RequestBody[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as RequestBody;
      seen.push(body);
      const reply = handler(seen.length, body);
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(reply.status === 200
        ? JSON.stringify({ choices: [{ message: { content: reply.content } }] })
        : JSON.stringify({ error: { message: reply.message ?? "error" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP address");
  try { await run(`http://127.0.0.1:${address.port}/v1`, seen); }
  finally { await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())); }
}

function runReview(baseUrl: string, outDir: string, diffPath: string, extraEnv: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", SCRIPT, "--diff", diffPath, "--out-dir", outDir, "--no-fix-brief"], {
      env: {
        ...process.env, LLM_API_KEY: "test-key", LLM_MODEL: "mock-model", LLM_PROVIDER: "openai", LLM_BASE_URL: baseUrl,
        // Default engine consistency-runs is 2; keep unit e2e at 1 unless a test overrides.
        LLM_RETRY_DELAY: "0", WORKERS: "1", FIX_BRIEF: "false", LLM_TEMPERATURE: "", CONSISTENCY_RUNS: "1", ...extraEnv,
      },
      windowsHide: true,
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function scenario(diff: string, handler: Parameters<typeof withMock>[0], extraEnv: Record<string, string>,
  check: (r: { code: number; stdout: string; stderr: string }, out: string, seen: RequestBody[]) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "reviewbrief-p2-"));
  const diffPath = join(dir, "pr.diff");
  writeFileSync(diffPath, diff);
  try {
    await withMock(handler, async (baseUrl, seen) => {
      const result = await runReview(baseUrl, dir, diffPath, extraEnv);
      await check(result, dir, seen);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const readFindings = (dir: string) => JSON.parse(readFileSync(join(dir, "findings.json"), "utf8"));

test("e2e: invented evidence is penalised, verified evidence is rewarded, and output is reproducible", async () => {
  const reply = (): Reply => ({ status: 200, content: findingsJson(
    finding({ title: "real" }),
    finding({ id: "S2", line: 2, title: "invented", evidence: "eval(user_input)" })) });
  let first = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    await scenario(DIFF, reply, {}, (r, out) => {
      assert.equal(r.code, 0, r.stderr);
      const file = readFindings(out);
      const real = file.findings.find((s: any) => s.title === "real");
      const invented = file.findings.find((s: any) => s.title === "invented");
      assert.equal(real.confidence, 0.95);
      assert.equal(real.confidenceBreakdown.evidence, "found");
      assert.equal(real.inline, true);
      assert.equal(invented.confidence, 0.6);
      assert.equal(invented.confidenceBreakdown.evidence, "not_found");
      assert.equal(invented.inline, false);
      assert.equal(JSON.parse(readFileSync(join(out, "review-payload.json"), "utf8")).comments.length, 1);
      const text = JSON.stringify(file.findings);
      if (attempt === 0) first = text; else assert.equal(text, first);
    });
  }
});

test("e2e: two consistency runs reward agreement, penalise one-run findings, and vary only the temperature", async () => {
  const a = finding({ title: "A", confidence: "medium" });
  const b = finding({ id: "S2", title: "B", category: "quality", line: 4, confidence: "medium", evidence: "return True" });
  const onceHigh = finding({ id: "S3", title: "Once", line: 2, evidence: "def run(cmd):" });
  await scenario(DIFF, (call) => ({
    status: 200,
    content: call === 1 ? findingsJson(a, b, onceHigh) : findingsJson(a),
  }), { CONSISTENCY_RUNS: "2" }, (r, out, seen) => {
      assert.equal(r.code, 0, r.stderr);
      const file = readFindings(out);
      assert.equal(file.runs, 2);
      assert.equal(file.agreementScoring, true);
      assert.equal(file.requireMultiRun, true);
      assert.equal(file.findings.find((s: any) => s.title === "A").confidence, 0.85);
      assert.equal(file.findings.find((s: any) => s.title === "B").confidence, 0.65);
      const once = file.findings.find((s: any) => s.title === "Once");
      assert.equal(once.confidenceBreakdown.agreement, "single");
      assert.equal(once.confidence, 0.85);
      assert.equal(once.inline, true); // high one-off still publishes; agreement only adjusted the score
      assert.equal(file.findings.find((s: any) => s.title === "A").inline, true);
      const payload = JSON.parse(readFileSync(join(out, "review-payload.json"), "utf8"));
      assert.equal(payload.comments.length, 2);
      assert.match(payload.body, /## Pull request overview/);
      assert.match(payload.body, /generated 2 comments/);
      // Findings live on inline threads (not duplicated in the overview list).
      const bodies = payload.comments.map((c: { body: string }) => c.body).join("\n");
      assert.match(bodies, /\*\*Once\*\*/);
      assert.match(bodies, /\*\*A\*\*/);
      assert.match(bodies, /<div align="right"><b>High<\/b><\/div>/);
      assert.doesNotMatch(bodies, /% confidence/);
      assert.deepEqual(seen.map((body) => body.temperature), [0, 0.4]);
    });
});

test("e2e: a model that rejects 'temperature' is retried once without it", async () => {
  await scenario(DIFF, (_call, body) => body.temperature !== undefined
    ? { status: 400, message: "temperature is not supported for this model" }
    : { status: 200, content: findingsJson(finding()) }, {}, (r, out, seen) => {
    assert.equal(r.code, 0, r.stderr);
    assert.equal(seen.length, 2);
    assert.equal(seen[0].temperature, 0);
    assert.equal(seen[1].temperature, undefined);
    assert.match(r.stderr, /retrying without it/);
    assert.equal(readFindings(out).findings.length, 1);
  });
});

test("e2e: LLM_TEMPERATURE=none omits the parameter entirely", async () => {
  await scenario(DIFF, () => ({ status: 200, content: findingsJson(finding()) }), { LLM_TEMPERATURE: "none" }, (r, _out, seen) => {
    assert.equal(r.code, 0, r.stderr);
    assert.equal(seen[0].temperature, undefined);
  });
});

test("e2e: a failed extra run disables agreement scoring visibly", async () => {
  await scenario(DIFF, (call) => call === 1
    ? { status: 200, content: findingsJson(finding({ confidence: "medium" })) }
    : { status: 400, message: "bad request" }, { CONSISTENCY_RUNS: "2" }, (r, out) => {
    assert.equal(r.code, 0, r.stderr);
    const file = readFindings(out);
    assert.equal(file.agreementScoring, false);
    assert.equal(file.findings[0].confidenceBreakdown.agreement, "n/a");
    assert.equal(file.findings[0].confidence, 0.75);
    assert.match(r.stdout, /::warning::A batch failed in a consistency run/);
    assert.match(readFileSync(join(out, "review.md"), "utf8"), /agreement scoring was not applied/);
  });
});

test("e2e: a diff with only skipped files still writes an empty findings.json", async () => {
  await scenario(LOCKFILE_DIFF, () => ({ status: 500 }), {}, (r, out) => {
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(readFindings(out).findings, []);
  });
});

test("e2e: malformed findings trigger one repair pass and recover corrected items", async () => {
  const valid = finding({ title: "kept" });
  const bad = { ...finding({ title: "broken" }), category: "bug" };
  const fixed = finding({ id: "S2", title: "broken", category: "quality" });
  await scenario(DIFF, (call, body) => {
    const user = body.messages?.find((m) => m.role === "user")?.content ?? "";
    if (call === 1) return { status: 200, content: findingsJson(valid, bad) };
    assert.match(user, /Rejected items/);
    assert.match(user, /category must be one of/);
    assert.match(user, /Do NOT resend the findings that were already accepted/);
    return { status: 200, content: findingsJson(fixed) };
  }, {}, (r, out, seen) => {
    assert.equal(r.code, 0, r.stderr);
    assert.equal(seen.length, 2);
    assert.match(r.stderr, /malformed finding\(s\); requesting repair/);
    assert.match(r.stdout, /repair recovered 1 finding/);
    const file = readFindings(out);
    assert.equal(file.dropped, 0);
    assert.deepEqual(file.findings.map((s: any) => s.title).sort(), ["broken", "kept"]);
  });
});
