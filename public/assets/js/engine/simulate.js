// Port of public/api/simulate.php. Keep the two in step: tests/parity.mjs compares them.
import { Timeline } from "./timeline.js";
import { enumField, intField, overheadField, validateProcesses, MAX_QUANTUM } from "./validate.js";

// Earliest arrival still in the future among unfinished processes (Infinity if none).
function nextArrival(procs, tl) {
  let next = Infinity;
  for (const p of procs) {
    if (tl.rem[p.pid] > 0 && p.arrival > tl.time) next = Math.min(next, p.arrival);
  }
  return next;
}

// Aging: every `aging` time units spent waiting improves a priority number by one (floor 1).
const effectivePriority = (base, waited, aging) => (aging > 0 ? Math.max(1, base - Math.floor(Math.trunc(waited) / aging)) : base);

// FCFS / SJF / Priority: pick the ready process with the lowest key(p, now) and run it to completion.
// Ties go to the earliest arrival because procs is sorted by arrival and the comparison is strict.
function runNonpreemptive(procs, overhead, key, reason) {
  const tl = new Timeline(procs, overhead);
  const pending = [...procs];
  while (pending.length) {
    let best = null;
    pending.forEach((p, k) => {
      if (p.arrival <= tl.time && (best === null || key(p, tl.time) < key(pending[best], tl.time))) best = k;
    });
    if (best === null) {
      tl.idleUntil(pending[0].arrival);
      continue;
    }
    const ready = pending.filter((q) => q.arrival <= tl.time).map((q) => [q.pid, key(q, tl.time)]);
    tl.decide(reason, pending[best].pid, ready);
    const [p] = pending.splice(best, 1);
    tl.switchTo(p.pid, p.vm);
    tl.run(p.pid, p.burst, p.vm);
  }
  return tl.results();
}

// SRTF: run the ready process with least remaining time until it finishes or the next arrival.
function runSrtf(procs, overhead) {
  const tl = new Timeline(procs, overhead);
  let left = procs.length;
  let last = null;
  while (left) {
    let best = null;
    for (const p of procs) {
      const rem = tl.rem[p.pid];
      if (rem > 0 && p.arrival <= tl.time && (best === null || rem < tl.rem[best.pid])) best = p;
    }
    if (best === null) {
      tl.idleUntil(nextArrival(procs, tl));
      continue;
    }
    const pid = best.pid;
    if (pid !== last) {
      tl.decide("least_remaining", pid, procs.filter((p) => tl.rem[p.pid] > 0 && p.arrival <= tl.time).map((p) => [p.pid, tl.rem[p.pid]]));
      last = pid;
    }
    tl.switchTo(pid, best.vm);
    tl.run(pid, Math.min(tl.rem[pid], nextArrival(procs, tl) - tl.time), best.vm);
    if (tl.rem[pid] <= 0) left--;
  }
  return tl.results();
}

// Preemptive priority: at every decision point the best effective priority runs. With aging the
// clock steps one unit at a time. A running process keeps the CPU on ties, and its own wait clock
// resets whenever it runs.
function runPriorityPreemptive(procs, overhead, aging) {
  const tl = new Timeline(procs, overhead);
  const readySince = {};
  for (const p of procs) readySince[p.pid] = p.arrival;
  let left = procs.length;
  let last = null;
  while (left) {
    let best = null;
    let bestKey = null;
    let lastKey = null;
    const ready = [];
    for (const p of procs) {
      const pid = p.pid;
      if (tl.rem[pid] <= 0 || p.arrival > tl.time) continue;
      const key = effectivePriority(p.priority, tl.time - readySince[pid], aging);
      ready.push([pid, key]);
      if (pid === last) lastKey = key;
      if (best === null || key < bestKey) {
        best = p;
        bestKey = key;
      }
    }
    if (best === null) {
      tl.idleUntil(nextArrival(procs, tl));
      continue;
    }
    if (lastKey !== null && lastKey === bestKey) best = procs.find((p) => p.pid === last);
    const pid = best.pid;
    if (pid !== last) tl.decide("best_priority", pid, ready);
    let len = Math.min(tl.rem[pid], nextArrival(procs, tl) - tl.time);
    if (aging > 0) len = Math.min(len, 1);
    tl.switchTo(pid, best.vm);
    tl.run(pid, len, best.vm);
    readySince[pid] = tl.time;
    last = pid;
    if (tl.rem[pid] <= 0) left--;
  }
  return tl.results();
}

// Round Robin (one level) and MLFQ (several levels, demoted after using a full quantum).
// New arrivals join the top queue before the preempted process is re-queued.
// MLFQ extras: a slice below the top level ends when a new job arrives, and every `boost` time units
// all jobs return to the top level. The boost is checked when the CPU is next dispatched.
function runFeedback(procs, overhead, quanta, boost = 0) {
  const tl = new Timeline(procs, overhead);
  const queues = quanta.map(() => []);
  const n = procs.length;
  let idx = 0;
  let left = n;
  let nextBoost = boost > 0 ? boost : Infinity;
  const admit = () => {
    while (idx < n && procs[idx].arrival <= tl.time) queues[0].push(procs[idx++]);
  };

  while (left) {
    admit();
    while (tl.time >= nextBoost) {
      for (let i = 1; i < queues.length; i++) {
        queues[0].push(...queues[i]);
        queues[i] = [];
      }
      nextBoost += boost;
    }
    const level = queues.findIndex((q) => q.length);
    if (level === -1) {
      tl.idleUntil(procs[idx].arrival);
      continue;
    }

    const p = queues[level].shift();
    const pid = p.pid;
    const ready = [[pid, level]];
    queues.forEach((q, i) => q.forEach((w) => ready.push([w.pid, i])));
    tl.decide("queue_front", pid, ready);
    tl.switchTo(pid, p.vm);
    admit();
    let len = Math.min(quanta[level], tl.rem[pid]);
    if (level > 0 && idx < n) len = Math.min(len, procs[idx].arrival - tl.time);
    tl.run(pid, len, p.vm);
    admit();

    if (tl.rem[pid] > 0) {
      const usedFullQuantum = len >= quanta[level];
      queues[usedFullQuantum ? Math.min(level + 1, quanta.length - 1) : level].push(p);
    } else {
      left--;
    }
  }
  return tl.results();
}

// Validates a request body like the PHP endpoint does and returns the same JSON shape.
export function simulate(input) {
  const algorithm = enumField(input.algorithm, "algorithm", ["FCFS", "SJF", "SRTF", "PRIORITY", "PRIORITYP", "RR", "MLFQ"], "FCFS");
  const quantum = intField(input.quantum, "quantum", 1, MAX_QUANTUM, 2);
  const aging = intField(input.aging, "aging", 0, 1000, 0);
  const mlfqBoost = intField(input.mlfqBoost, "mlfqBoost", 0, 10000, 0);
  const cs = overheadField(input.csOverhead);
  const procs = validateProcesses(input.processes);
  switch (algorithm) {
    case "FCFS": return runNonpreemptive(procs, cs, (p) => p.arrival, "first_arrived");
    case "SJF": return runNonpreemptive(procs, cs, (p) => p.burst, "shortest_burst");
    case "PRIORITY": return runNonpreemptive(procs, cs, (p, t) => effectivePriority(p.priority, t - p.arrival, aging), "best_priority");
    case "PRIORITYP": return runPriorityPreemptive(procs, cs, aging);
    case "SRTF": return runSrtf(procs, cs);
    case "RR": return runFeedback(procs, cs, [quantum]);
    case "MLFQ": return runFeedback(procs, cs, [quantum, quantum * 2, quantum * 4], mlfqBoost);
  }
}
