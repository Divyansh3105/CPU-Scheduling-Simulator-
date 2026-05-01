// Port of src/Timeline.php: records what the CPU does over time and derives per-process metrics.
// Context switch rule (all algorithms): overhead is charged, and counted, whenever the CPU
// dispatches a different process than the one that ran last. The first dispatch is free.
export class Timeline {
  constructor(procs, overhead) {
    this.procs = procs;
    this.overhead = overhead;
    this.time = 0;
    this.segments = [];
    this.decisions = [];
    this.decisionsTruncated = false;
    this.rem = {};
    this.first = {};
    this.finish = {};
    this.switches = {};
    this.last = null;
    for (const p of procs) {
      this.rem[p.pid] = p.burst;
      this.switches[p.pid] = 0;
    }
  }

  idleUntil(t) {
    if (t > this.time) this.add("IDLE", t, "");
  }

  // extra: additional dispatch cost (cache miss, paging) shown together with the switch overhead.
  switchTo(pid, vm, extra = 0) {
    let cost = extra;
    if (this.last !== null && this.last !== pid) {
      this.switches[pid]++;
      cost += this.overhead;
    }
    if (cost > 0) this.add("CS", this.time + cost, vm);
    this.last = pid;
  }

  // Why pid was picked now. ready: array of [pid, comparison value].
  decide(reason, pid, ready) {
    if (this.decisions.length >= 1000) { // each entry holds the whole ready set, so the log is capped
      this.decisionsTruncated = true;
      return;
    }
    this.decisions.push({ time: this.time, pid, reason, ready: ready.map(([p, value]) => ({ pid: p, value })) });
  }

  run(pid, len, vm) {
    this.first[pid] ??= this.time;
    this.add(pid, this.time + len, vm);
    this.rem[pid] -= len;
    if (this.rem[pid] <= 0) this.finish[pid] = this.time;
  }

  penalty(label, len, vm) {
    if (len > 0) this.add(label, this.time + len, vm);
  }

  add(pid, end, vm) {
    const last = this.segments[this.segments.length - 1];
    if (last && last.pid === pid && last.vm === vm && last.end === this.time) {
      last.end = end;
    } else {
      this.segments.push({ pid, start: this.time, end, vm });
    }
    this.time = end;
  }

  results() {
    const results = this.procs.map((p) => {
      const turnaround = this.finish[p.pid] - p.arrival;
      return {
        pid: p.pid,
        vm: p.vm,
        arrival: p.arrival,
        burst: p.burst,
        completion: this.finish[p.pid],
        turnaround,
        waiting: turnaround - p.burst,
        response: this.first[p.pid] - p.arrival,
        contextSwitches: this.switches[p.pid],
      };
    });
    return {
      results,
      segments: this.segments,
      decisions: this.decisions,
      decisionsTruncated: this.decisionsTruncated,
      contextSwitches: Object.values(this.switches).reduce((a, b) => a + b, 0),
    };
  }
}
