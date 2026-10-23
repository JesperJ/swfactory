import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, isJobCommand, STALE_JOB_HOURS } from "../src/db.ts";

const job = { project: "shop", feature: "003-login", command: "build" as const };

test("a second tap returns the queued job instead of starting another", () => {
  const s = new Store(":memory:");
  const first = s.enqueue(job);
  assert.equal(first.created, true);

  const second = s.enqueue(job);
  assert.equal(second.created, false, "a duplicate must not create a second job");
  assert.equal(second.job.id, first.job.id);
  assert.equal(s.listJobs().length, 1);
});

test("a different feature in the same project is not a duplicate", () => {
  const s = new Store(":memory:");
  s.enqueue(job);
  assert.equal(s.enqueue({ ...job, feature: "004-export" }).created, true);
  assert.equal(s.listJobs().length, 2);
});

test("once a job finishes the feature can be queued again", () => {
  const s = new Store(":memory:");
  const { job: first } = s.enqueue(job);
  s.setJobStatus(first.id, "done");
  const again = s.enqueue(job);
  assert.equal(again.created, true, "a finished job must not block the next one");
  assert.notEqual(again.job.id, first.id);
});

test("claiming is compare-and-swap, so two runners cannot take the same job", () => {
  const s = new Store(":memory:");
  s.enqueue(job);
  const a = s.claimNext();
  const b = s.claimNext();
  assert.equal(a?.status, "claimed");
  assert.equal(b, undefined, "the second claim must come back empty");
});

test("claimNext takes the oldest queued job first", () => {
  const s = new Store(":memory:");
  s.enqueue({ ...job, feature: "001-a" }, "2026-10-23T10:00:00.000Z");
  s.enqueue({ ...job, feature: "002-b" }, "2026-10-23T09:00:00.000Z");
  assert.equal(s.claimNext()?.feature, "002-b");
});

test("a failure keeps its reason and stays listed", () => {
  const s = new Store(":memory:");
  const { job: j } = s.enqueue(job);
  const failed = s.setJobStatus(j.id, "failed", { error: "no checkout matching github.com/acme/shop" });
  assert.equal(failed?.status, "failed");
  assert.match(failed!.error!, /no checkout matching/);
  assert.ok(failed!.finished_at, "a terminal status records when it ended");
  assert.equal(s.listJobs()[0].id, j.id, "a recent failure stays visible");
});

test("running is not terminal: it keeps blocking duplicates and leaves finished_at unset", () => {
  const s = new Store(":memory:");
  const { job: j } = s.enqueue(job);
  const running = s.setJobStatus(j.id, "running", { sessionId: "sess-1" });
  assert.equal(running?.finished_at, null);
  assert.equal(running?.session_id, "sess-1");
  assert.equal(s.enqueue(job).created, false, "a running job still blocks a duplicate");
});

test("setJobStatus does not wipe fields it was not given", () => {
  const s = new Store(":memory:");
  const { job: j } = s.enqueue(job);
  s.setJobStatus(j.id, "running", { sessionId: "sess-1" });
  const done = s.setJobStatus(j.id, "done");
  assert.equal(done?.session_id, "sess-1", "the session id must survive a later status change");
});

test("only the three allowed commands are commands", () => {
  assert.ok(isJobCommand("build"));
  assert.ok(isJobCommand("plan"));
  assert.ok(isJobCommand("spec"));
  for (const bad of ["approve", "rm -rf /", "", "BUILD", null, 7, undefined]) {
    assert.equal(isJobCommand(bad), false, `${String(bad)} must not be a command`);
  }
});

const HOURS = 3600_000;
const at = (ms: number) => new Date(ms).toISOString();

test("an unfinished job stops blocking once it is older than the stale window", () => {
  // Round 2: a job stuck at `running` blocked every future tap for its feature forever,
  // turning "two taps don't start two sessions" into "no tap ever starts one again".
  const s = new Store(":memory:");
  const t0 = Date.now();
  const { job: first } = s.enqueue(job, at(t0));
  s.setJobStatus(first.id, "running", {}, at(t0));

  const soon = s.enqueue(job, at(t0 + 1 * HOURS));
  assert.equal(soon.created, false, "a job still within the window keeps blocking");

  const later = s.enqueue(job, at(t0 + (STALE_JOB_HOURS + 1) * HOURS));
  assert.equal(later.created, true, "past the window the feature is workable again");
  assert.notEqual(later.job.id, first.id);
});

test("a job that never got claimed also stops blocking", () => {
  const s = new Store(":memory:");
  const t0 = Date.now();
  s.enqueue(job, at(t0)); // stays `queued` — no runner installed
  assert.equal(s.enqueue(job, at(t0 + (STALE_JOB_HOURS + 1) * HOURS)).created, true);
});

test("listJobs marks the same jobs stale that enqueue stopped blocking on", () => {
  const s = new Store(":memory:");
  const t0 = Date.now();
  const { job: j } = s.enqueue(job, at(t0));
  s.setJobStatus(j.id, "running", {}, at(t0));

  assert.equal(s.listJobs(24, new Date(t0 + 1 * HOURS))[0].stale, false);
  const after = new Date(t0 + (STALE_JOB_HOURS + 1) * HOURS);
  assert.equal(s.listJobs(24, after)[0].stale, true, "the UI must agree with the guard");
  assert.equal(s.enqueue(job, after.toISOString()).created, true);
});

test("a finished job is never stale — it is simply done", () => {
  const s = new Store(":memory:");
  const t0 = Date.now();
  const { job: j } = s.enqueue(job, at(t0));
  s.setJobStatus(j.id, "done", {}, at(t0));
  const rows = s.listJobs(24, new Date(t0 + (STALE_JOB_HOURS + 1) * HOURS));
  assert.equal(rows[0].stale, false);
});

test("listRunning returns exactly the jobs the runner should reconcile", () => {
  const s = new Store(":memory:");
  const a = s.enqueue({ ...job, feature: "001-a" }).job;
  const b = s.enqueue({ ...job, feature: "002-b" }).job;
  s.enqueue({ ...job, feature: "003-c" });
  s.setJobStatus(a.id, "running");
  s.setJobStatus(b.id, "done");
  assert.deepEqual(s.listRunning().map((j) => j.feature), ["001-a"]);
});
