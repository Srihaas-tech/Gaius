#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = fs.readFileSync(path.join(
  root,
  "port/src/main/java/dev/gaius/browser/BrowserIntegratedServerMain.java",
), "utf8");

const signalStart = source.indexOf("public static void signalIntegratedServerNetworkInput()");
const scheduleStart = source.indexOf("private static boolean scheduleNetworkInputTask(", signalStart);
const runStart = source.indexOf("private static void runScheduledNetworkInput()", scheduleStart);
const nextMethod = source.indexOf("public static void pumpIntegratedServerNetworkInput()", runStart);
assert.ok(signalStart >= 0 && scheduleStart > signalStart && runStart > scheduleStart &&
  nextMethod > runStart);

const signal = source.slice(signalStart, scheduleStart);
const schedule = source.slice(scheduleStart, runStart);
const run = source.slice(runStart, nextMethod);
const pendingPumpStart = source.indexOf("public static void pumpUrgentPacketsIfPending()");
const pendingPumpEnd = source.indexOf(
  "/** Wakes the parked server thread",
  pendingPumpStart,
);
const pendingPump = source.slice(pendingPumpStart, pendingPumpEnd);
assert.ok(pendingPumpStart >= 0 && pendingPumpEnd > pendingPumpStart);
assert.match(source, /MAX_NETWORK_INPUT_FOLLOWUPS = 4;/);
assert.match(source, /MAX_NETWORK_INPUT_DEFERRED_RETRIES = 4;/);
assert.match(source,
  /private static final AtomicBoolean NETWORK_INPUT_TASK_SCHEDULED = new AtomicBoolean\(\);/);
assert.doesNotMatch(signal, /networkInputFollowupsRemaining = MAX_NETWORK_INPUT_FOLLOWUPS/);
assert.match(signal, /recordNetworkInputPending\(true\);/);
assert.match(signal, /scheduleNetworkInputTask\(false, true\);/);
assert.match(schedule, /currentServerThread == null \|\| serverThreadExited/);
assert.match(schedule, /!current\.isRunning\(\)/);
assert.match(schedule, /NETWORK_INPUT_TASK_SCHEDULED\.compareAndSet\(false, true\)/);
assert.ok(
  schedule.indexOf("NETWORK_INPUT_TASK_SCHEDULED.compareAndSet(false, true)") <
    schedule.indexOf("networkInputFollowupsRemaining = MAX_NETWORK_INPUT_FOLLOWUPS"),
  "coalesced signals must not refresh the active burst budget",
);
const enqueue = schedule.indexOf(
  "TickTask task = new TickTask(Integer.MIN_VALUE, NETWORK_INPUT_TASK)",
);
assert.ok(enqueue >= 0, "network task must use an overdue TickTask");
assert.ok(
  schedule.indexOf("LockSupport.unpark(currentServerThread)", enqueue) > enqueue,
  "a newly claimed task must be enqueued before its explicit wake",
);
assert.ok(
  schedule.indexOf("LockSupport.unpark(currentServerThread)") < enqueue,
  "a coalesced signal must refresh the queued task's wake permit",
);
assert.match(source, /bindServerThreadFromServerLoop/);
assert.match(source, /bound from MinecraftServer\.pollTask/);
assert.ok(
  pendingPump.indexOf("bindServerThreadFromServerLoop") <
    pendingPump.indexOf("BrowserWebSocketChannel.hasPendingInput"),
  "the server-loop thread binding must happen before pending input is drained",
);
const strictDrainStart = source.indexOf("private static boolean drainUrgentPackets()");
const scheduledDrainStart = source.indexOf(
  "private static boolean drainScheduledNetworkInput()",
  strictDrainStart,
);
const sharedDrainStart = source.indexOf(
  "private static boolean drainUrgentPacketsFromServerLoop(MinecraftServer current)",
  scheduledDrainStart,
);
assert.ok(strictDrainStart >= 0 && scheduledDrainStart > strictDrainStart &&
  sharedDrainStart > scheduledDrainStart);
const strictDrain = source.slice(strictDrainStart, scheduledDrainStart);
const scheduledDrain = source.slice(scheduledDrainStart, sharedDrainStart);
assert.match(strictDrain, /Thread\.currentThread\(\) != serverThread/,
  "generic packet drains must retain strict server-thread identity");
assert.match(scheduledDrain, /serverThreadExited \|\| !current\.isRunning\(\)/,
  "the private scheduled task must retain the server lifecycle guard");
assert.match(scheduledDrain, /!NETWORK_INPUT_TASK_SCHEDULED\.get\(\)/,
  "the private scheduled task must possess the one-task permit");
assert.match(scheduledDrain, /activeNetworkInputTask == null/,
  "the private scheduled task must hold an exact-dispatch lease");
assert.doesNotMatch(scheduledDrain, /Thread\.currentThread\(\) != serverThread/,
  "TeaVM Thread wrapper identity must not reject a task consumed by the server queue");
assert.match(source, /task instanceof TickTask/,
  "only a TickTask may acquire the network-input lease");
assert.match(source, /tickTask\.getTick\(\) != Integer\.MIN_VALUE/,
  "only the reserved overdue network TickTask may acquire the network-input lease");
assert.match(source, /beginScheduledNetworkInputTask\(Runnable task\)/);
assert.match(source, /endScheduledNetworkInputTask\(Runnable task, boolean entered\)/);
assert.match(run, /pumped = drainScheduledNetworkInput\(\);/);
assert.match(run, /network-pump-wrong-thread/);
assert.match(run, /lost its integrated server lifecycle permit/);
assert.match(run, /finally\s*\{\s*NETWORK_INPUT_TASK_SCHEDULED\.set\(false\);/s);
assert.match(run, /retryNetworkInputAfterTaskFailure\(\);/);
assert.match(run, /Pending input remained after the integrated server stopped/);
assert.match(run, /networkInputFollowupsRemaining <= 0/);
assert.match(run, /networkInputFollowupsRemaining--;/);
assert.match(run, /scheduleNetworkInputTask\(true, false\);/);
assert.match(run, /deferNetworkInputRetry\(\);/);
assert.match(run, /TModernRuntimeSupport\.yieldToEventLoop\(delayMillis\);/);
assert.match(run, /scheduleNetworkInputTask\(false, false\);/);
assert.match(run, /network-pump-retry-exhausted/);
assert.doesNotMatch(run, /signalIntegratedServerNetworkInput\(\);/);
assert.doesNotMatch(run, /new Thread|setTimeout\(|setInterval\(/);
assert.match(source, /integratedServerTaskBudgetExhaustions/);
assert.match(source, /integratedServerTaskWrongThread/);
assert.match(source, /var field = '';/,
  "TeaVM's JSBody parser requires a var declaration for the event field");
assert.doesNotMatch(source, /let field = '';/);

let scheduled = false;
let active = true;
let burstActive = false;
let followupsRemaining = 0;
let deferredRetriesRemaining = 0;
let signals = 0;
let schedules = 0;
let unparks = 0;
let coalesced = 0;
let followups = 0;
let runs = 0;
let wrongThread = 0;
let serverThreadRuns = 0;
let pendingInput = false;
let lifecycleDrops = 0;
let budgetExhaustions = 0;
let deferredRetries = 0;
let retryExhaustions = 0;
const scheduleModel = (followup, externalSignal) => {
  if (!active) {
    lifecycleDrops++;
    return false;
  }
  if (scheduled) {
    unparks++;
    coalesced++;
    return false;
  }
  if (!followup) {
    if (!externalSignal) {
      burstActive = true;
      followupsRemaining = 4;
    } else if (!burstActive) {
      burstActive = true;
      followupsRemaining = 4;
      deferredRetriesRemaining = 4;
    }
  }
  scheduled = true;
  schedules++;
  unparks++;
  if (followup) followups++;
  return true;
};
const signalModel = () => {
  signals++;
  pendingInput = true;
  return scheduleModel(false, true);
};
const finishBurstModel = () => {
  burstActive = false;
  followupsRemaining = 0;
  deferredRetriesRemaining = 0;
};
const runModel = ({
  pendingAfterPump,
  lifecyclePermit = true,
  threadWrapperMatches = true,
  exactTask = true,
  resumeDeferred = true,
}) => {
  scheduled = false;
  runs++;
  // A task consumed from the private server queue is trusted even when TeaVM restores it with a
  // different Java Thread wrapper. Only a lost lifecycle/one-task permit makes the drain fail.
  const pumpSucceeded = lifecyclePermit && exactTask;
  void threadWrapperMatches;
  if (!pumpSucceeded) {
    wrongThread++;
    if (!pendingInput) {
      finishBurstModel();
      return;
    }
    if (!burstActive) {
      burstActive = true;
      followupsRemaining = 0;
      deferredRetriesRemaining = 4;
    }
    if (deferredRetriesRemaining <= 0) {
      retryExhaustions++;
      finishBurstModel();
      return;
    }
    deferredRetriesRemaining--;
    deferredRetries++;
    if (resumeDeferred) scheduleModel(false, false);
    return;
  }
  serverThreadRuns++;
  pendingInput = pendingAfterPump;
  if (!pendingAfterPump) {
    finishBurstModel();
    return;
  }
  if (!active) {
    finishBurstModel();
    lifecycleDrops++;
    return;
  }
  if (followupsRemaining <= 0) {
    budgetExhaustions++;
    if (deferredRetriesRemaining <= 0) {
      retryExhaustions++;
      finishBurstModel();
      return;
    }
    deferredRetriesRemaining--;
    deferredRetries++;
    if (resumeDeferred) scheduleModel(false, false);
    return;
  }
  followupsRemaining--;
  scheduleModel(true, false);
};

signalModel();
signalModel();
signalModel();
assert.equal(schedules, 1, "coalesced input must keep one queued server task");
assert.equal(unparks, 3, "coalesced input must still refresh every wake permit");
assert.equal(coalesced, 2);
runModel({pendingAfterPump: true});
assert.equal(schedules, 2, "pending input after a drain must schedule a follow-up");
assert.equal(followupsRemaining, 3);
signalModel();
assert.equal(followupsRemaining, 3,
  "a coalesced external signal must not refresh the current burst budget");
assert.equal(scheduled, true);
runModel({pendingAfterPump: false});
assert.equal(scheduled, false);

signalModel();
for (let index = 0; index < 4; index++) {
  runModel({pendingAfterPump: true});
}
runModel({pendingAfterPump: true, resumeDeferred: false});
assert.equal(burstActive, true);
assert.equal(followupsRemaining, 0);
assert.equal(deferredRetriesRemaining, 3);
signalModel();
assert.equal(followupsRemaining, 0,
  "external input during a deferred retry must not replenish follow-ups");
assert.equal(deferredRetriesRemaining, 3,
  "external input during a deferred retry must not replenish retry budget");
scheduleModel(false, false);
assert.equal(followupsRemaining, 0,
  "a coalesced deferred continuation must not replenish the claimed task");
runModel({pendingAfterPump: false});
assert.equal(burstActive, false);

const budgetExhaustionsBeforeStuckBacklog = budgetExhaustions;
const deferredRetriesBeforeStuckBacklog = deferredRetries;
const retryExhaustionsBeforeStuckBacklog = retryExhaustions;
signalModel();
for (let index = 0; index < 25; index++) {
  runModel({pendingAfterPump: true});
}
assert.equal(followupsRemaining, 0);
assert.equal(budgetExhaustions - budgetExhaustionsBeforeStuckBacklog, 5,
  "each bounded burst must yield before retrying");
assert.equal(deferredRetries - deferredRetriesBeforeStuckBacklog, 4,
  "bounded backlog must receive four delayed retries");
assert.equal(retryExhaustions - retryExhaustionsBeforeStuckBacklog, 1,
  "a permanently stuck backlog must terminate explicitly");
assert.equal(scheduled, false);

signalModel();
const serverThreadRunsBeforeWrongThread = serverThreadRuns;
runModel({pendingAfterPump: false, threadWrapperMatches: false});
assert.equal(wrongThread, 0,
  "a scheduled server task must survive TeaVM Thread wrapper replacement");
assert.equal(serverThreadRuns - serverThreadRunsBeforeWrongThread, 1,
  "wrapper replacement must still produce exactly one trusted server-queue drain");
assert.equal(scheduled, false);
assert.equal(pendingInput, false);

signalModel();
runModel({pendingAfterPump: true, exactTask: false});
assert.equal(wrongThread, 1,
  "a different queued runnable must not acquire the network-input lease");
assert.equal(scheduled, true);
runModel({pendingAfterPump: false});

signalModel();
const serverThreadRunsBeforePermitFailure = serverThreadRuns;
const wrongThreadBeforePermitFailure = wrongThread;
runModel({pendingAfterPump: true, lifecyclePermit: false});
assert.equal(wrongThread - wrongThreadBeforePermitFailure, 1);
assert.equal(scheduled, true, "lost-permit execution must retain a bounded retry");
assert.equal(pendingInput, true, "lost-permit execution must retain queued input");
runModel({pendingAfterPump: false});
assert.equal(serverThreadRuns - serverThreadRunsBeforePermitFailure, 1,
  "a lost-permit task must be followed by exactly one trusted server-queue execution");
assert.equal(scheduled, false);
assert.equal(pendingInput, false);
assert.equal(deferredRetriesRemaining, 0,
  "successful recovery must clear delayed retry state");

const wrongThreadRetryExhaustionsBefore = retryExhaustions;
signalModel();
for (let index = 0; index < 5; index++) {
  runModel({pendingAfterPump: true, lifecyclePermit: false});
}
assert.equal(retryExhaustions - wrongThreadRetryExhaustionsBefore, 1,
  "a permanently wrong-thread task must fail closed after bounded retries");
assert.equal(scheduled, false);
assert.equal(burstActive, false);
assert.equal(deferredRetriesRemaining, 0,
  "wrong-thread exhaustion must clear delayed retry state");
assert.equal(pendingInput, true,
  "wrong-thread exhaustion must leave the physical input backlog observable");

active = false;
signalModel();
assert.equal(lifecycleDrops, 1, "stopped servers must reject late input tasks");
assert.equal(scheduled, false);
assert.equal(unparks, schedules + coalesced,
  "every successful schedule and coalesced signal must issue exactly one explicit wake");
assert.ok(schedules - followups <= signals + deferredRetries,
  "successful initial schedules cannot exceed external signals and retries");
assert.ok(followups <= schedules, "follow-up schedules must be a subset of all schedules");
assert.match(source, /integratedServerTaskTelemetryVersion !== 1/);
for (const field of [
  "integratedServerPumpFailures",
  "integratedServerTaskScheduleFailures",
  "integratedServerTaskWrongThread",
  "integratedServerTaskBudgetExhaustions",
]) {
  assert.match(source, new RegExp(`stats\\.${field} =`), `${field} must initialize to zero`);
}

console.log(JSON.stringify({
  ok: true,
  signals,
  schedules,
  unparks,
  coalesced,
  followups,
  runs,
  boundedFollowupDrain: true,
  scheduledTaskIgnoresTeaVMThreadWrapperIdentity: true,
  genericDrainRetainsStrictThreadIdentity: true,
  wrongThreadRetriesBounded: true,
  wrongThreadExactlyOnceServerRun: true,
  wrongThreadFailClosed: true,
  lifecycleGuard: true,
}));
