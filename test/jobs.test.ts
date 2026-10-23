import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, isJobCommand } from "../src/db.ts";

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
