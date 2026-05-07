// Port of public/api/simulate_hypervisor.php. Keep the two in step: tests/parity.mjs compares them.
import { Timeline } from "./timeline.js";
import {
  MAX_QUANTUM, MAX_VMS, boolField, enumField, intField, nameField, overheadField, validateProcesses,
} from "./validate.js";

const ALGORITHMS = ["FCFS", "SJF", "SRTF", "PRIORITY", "PRIORITYP", "RR", "MLFQ"];
const VM_SCHEDULERS = ["RR", "PRIORITY", "PROPORTIONAL", "CREDIT", "LOTTERY"];
const VM_TYPES = ["standard", "compute", "memory", "realtime"];
const TOTAL_SYSTEM_MEMORY = 8192;
const CACHE_SIZE = 8;
const CACHE_MISS_PENALTY = 2;
const PAGING_PENALTY = 1;
const NUMA_PENALTY = 2;
const MIGRATION_IMBALANCE = 3;

// MT19937 matching PHP's mt_srand()/mt_rand(min, max), so lottery draws equal the PHP results.
class MersenneTwister {
  constructor(seed) {
    this.mt = new Uint32Array(624);
    this.mt[0] = seed >>> 0;
    for (let i = 1; i < 624; i++) {
      const prev = this.mt[i - 1] ^ (this.mt[i - 1] >>> 30);
      this.mt[i] = (Math.imul(1812433253, prev) + i) >>> 0;
    }
    this.i = 624;
  }

  next32() {
    const mt = this.mt;
    if (this.i >= 624) {
      for (let k = 0; k < 624; k++) {
        const y = (mt[k] & 0x80000000) | (mt[(k + 1) % 624] & 0x7fffffff);
        mt[k] = mt[(k + 397) % 624] ^ (y >>> 1) ^ (mt[(k + 1) % 624] & 1 ? 0x9908b0df : 0);
      }
      this.i = 0;
    }
    let y = mt[this.i++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  range(min, max) {
    const umax = max - min;
    let result = this.next32();
    if (umax === 0xffffffff) return min + result;
    const span = umax + 1;
    if ((span & (span - 1)) === 0) return min + (result & (span - 1));
    const limit = 0xffffffff - (0xffffffff % span) - 1;
    while (result > limit) result = this.next32();
    return min + (result % span);
  }
}

// LRU cache of recently run (vm, pid) working sets.
class CPUCache {
  constructor() {
    this.cache = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  access(pid, vm) {
    const key = `${vm}:${pid}`;
    const hit = this.cache.has(key);
    this.cache.delete(key);
    if (!hit && this.cache.size >= CACHE_SIZE) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(key, true);
    if (hit) this.hits++;
    else this.misses++;
    return hit;
  }

  stats() {
    const total = this.hits + this.misses;
    return { hits: this.hits, misses: this.misses, hitRate: total ? (this.hits / total) * 100 : 0 };
  }
}

export function validateVms(list, processes) {
  if (!Array.isArray(list)) throw new Error("vms must be an array");
  if (list.length > MAX_VMS) throw new Error(`At most ${MAX_VMS} VMs are allowed`);
  const vms = new Map();
  list.forEach((v, i) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error(`vms[${i}] must be an object`);
    const name = nameField(v.name, `vms[${i}].name`);
    if (name === "Host" || vms.has(name)) throw new Error(`Duplicate or reserved VM name: ${name}`);
    const type = v.type ?? "standard";
    if (!VM_TYPES.includes(type)) throw new Error(`${name}.type must be one of: ${VM_TYPES.join(", ")}`);
    vms.set(name, {
      name,
      priority: intField(v.priority, `${name}.priority`, 1, 10, 5),
      cpuShare: intField(v.cpuShare, `${name}.cpuShare`, 1, 100, 25),
      memory: intField(v.memory, `${name}.memory`, 128, 65536, 512),
      type,
    });
  });
  let usesHost = false;
  for (const p of processes) {
    if (p.vm === "Host") usesHost = true;
    else if (!vms.has(p.vm)) throw new Error(`Process ${p.pid} is assigned to unknown VM ${p.vm}`);
  }
  if (usesHost) vms.set("Host", { name: "Host", priority: 0, cpuShare: 100, memory: 4096, type: "standard" });
  return vms;
}

function schedule(vms, processes, processAlgo, processQuantum, vmScheduler, vmQuantum, csOverhead, migrationPenalty, mlfqBoost, seed, features) {
  const rng = new MersenneTwister(seed);
  const tl = new Timeline(processes, csOverhead);
  const cache = new CPUCache();
  const vmNames = [...vms.keys()];
  const vmOf = (name) => vms.get(name);

  // Memory ballooning: when overcommitted, every VM is squeezed proportionally into physical memory.
  const effectiveMemory = Object.create(null);
  let allocated = 0;
  for (const [name, v] of vms) {
    effectiveMemory[name] = v.memory;
    allocated += v.memory;
  }
  if (features.overcommit && allocated > TOTAL_SYSTEM_MEMORY) {
    for (const name of vmNames) effectiveMemory[name] = Math.floor((effectiveMemory[name] * TOTAL_SYSTEM_MEMORY) / allocated);
  }

  const proc = Object.create(null);
  for (const p of processes) proc[p.pid] = { ...p };

  const stats = Object.create(null);
  const credits = Object.create(null);
  const node = Object.create(null);
  vmNames.forEach((name, i) => {
    node[name] = i % 2;
    stats[name] = {
      vm: name, cpuTime: 0, idleTime: 0, processCount: 0, migrations: 0, memoryUsed: 0,
      effectiveMemory: effectiveMemory[name], utilization: 0, ioOperations: 0, cacheHits: 0, cacheMisses: 0,
      numaNode: node[name], numaHops: 0, overcommitEvents: 0,
    };
    credits[name] = vmOf(name).cpuShare;
  });

  const queues = Object.create(null);
  for (const name of vmNames) queues[name] = [];
  const current = Object.create(null);
  const blocked = new Map(); // pid -> time its I/O completes
  const ioIdx = Object.create(null);
  const ioQueue = [];
  let ioSeq = 0;
  let deviceFree = 0;
  const ioSchedule = [];
  const level = Object.create(null);
  for (const p of processes) level[p.pid] = 0;
  let nextBoost = mlfqBoost > 0 ? mlfqBoost : Infinity;
  let lastVM = null;
  const migrations = [];
  const ranOn = Object.create(null);
  let rrPos = -1;
  const n = processes.length;
  let idx = 0;
  let left = n;
  const nonPreemptive = ["FCFS", "SJF", "PRIORITY"].includes(processAlgo);
  const sliced = ["RR", "MLFQ"].includes(processAlgo);
  const minReq = () => Math.min(...ioQueue.map((r) => r.req));

  // The device serves one request at a time. When it frees up it takes the waiting request with the
  // best (lowest) priority number, oldest first; only requests made by then are considered.
  const serveDevice = () => {
    while (ioQueue.length) {
      const start = Math.max(deviceFree, minReq());
      if (start > tl.time) return;
      let best = null;
      ioQueue.forEach((r, k) => {
        if (r.req <= start && (best === null || r.prio < ioQueue[best].prio || (r.prio === ioQueue[best].prio && r.seq < ioQueue[best].seq))) best = k;
      });
      const [r] = ioQueue.splice(best, 1);
      deviceFree = start + r.dur;
      blocked.set(r.pid, deviceFree);
      ioSchedule.push({ pid: r.pid, vm: r.vm, ioTime: r.dur, priority: r.prio, requestTime: r.req, startTime: start });
    }
  };
  const boostCheck = () => {
    while (processAlgo === "MLFQ" && tl.time >= nextBoost) {
      for (const q of Object.keys(level)) level[q] = 0;
      nextBoost += mlfqBoost;
    }
  };
  const admit = () => {
    serveDevice();
    while (idx < n && processes[idx].arrival <= tl.time) {
      const pid = processes[idx++].pid;
      queues[proc[pid].vm].push(pid);
    }
    const byTime = [...blocked].sort((a, b) => a[1] - b[1]); // stable, like PHP 8 asort
    for (const [pid, until] of byTime) {
      if (until > tl.time) break;
      blocked.delete(pid);
      queues[proc[pid].vm].push(pid);
    }
  };
  const dequeue = (vm, pid) => {
    queues[vm] = queues[vm].filter((q) => q !== pid);
  };

  while (left) {
    admit();
    boostCheck();
    const ready = vmNames.filter((v) => queues[v].length);

    if (!ready.length) {
      let next = blocked.size ? Math.min(...blocked.values()) : Infinity;
      if (ioQueue.length) next = Math.min(next, Math.max(deviceFree, minReq()));
      if (idx < n) next = Math.min(next, processes[idx].arrival);
      tl.idleUntil(next);
      continue;
    }

    // --- VM level: choose which VM gets the CPU for the next slice ---
    let vm;
    switch (vmScheduler) {
      case "PRIORITY":
        ready.sort((a, b) => vmOf(a).priority - vmOf(b).priority);
        vm = ready[0];
        break;
      case "PROPORTIONAL":
        ready.sort((a, b) => stats[a].cpuTime / vmOf(a).cpuShare - stats[b].cpuTime / vmOf(b).cpuShare);
        vm = ready[0];
        break;
      case "CREDIT":
        while (Math.max(...ready.map((v) => credits[v])) <= 0) {
          for (const v of vmNames) credits[v] = Math.min(credits[v] + vmOf(v).cpuShare, vmOf(v).cpuShare);
        }
        ready.sort((a, b) => credits[b] - credits[a]);
        vm = ready[0];
        break;
      case "LOTTERY": {
        let draw = rng.range(1, ready.reduce((s, v) => s + vmOf(v).cpuShare, 0));
        for (const v of ready) {
          vm = v;
          draw -= vmOf(v).cpuShare;
          if (draw <= 0) break;
        }
        break;
      }
      default: {
        const count = vmNames.length;
        for (let i = 1; i <= count; i++) {
          const pos = (rrPos + i) % count;
          if (queues[vmNames[pos]].length) {
            vm = vmNames[pos];
            rrPos = pos;
            break;
          }
        }
      }
    }

    // --- Load balancing: move one waiting process to the least loaded guest VM ---
    if (features.migration && vm !== "Host") {
      let target = null;
      for (const v of vmNames) {
        if (v !== vm && v !== "Host" && (target === null || queues[v].length < queues[target].length)) target = v;
      }
      if (target !== null && queues[vm].length - queues[target].length >= MIGRATION_IMBALANCE) {
        const movable = queues[vm].filter((q) => q !== (current[vm] ?? null));
        const pid = movable[movable.length - 1];
        dequeue(vm, pid);
        queues[target].push(pid);
        proc[pid].vm = target;
        stats[vm].migrations++;
        migrations.push({ process: pid, fromVM: vm, toVM: target, time: tl.time, penalty: migrationPenalty });
        tl.penalty("MIGRATION", migrationPenalty, `${vm}→${target}`);
        continue;
      }
    }

    // --- Process level: run the VM's processes for up to vmQuantum time units ---
    let budget = vmQuantum;
    while (budget > 0 && queues[vm].length) {
      boostCheck();
      const queue = queues[vm];
      let pid;
      if (nonPreemptive && current[vm] !== undefined && queue.includes(current[vm])) {
        pid = current[vm];
      } else {
        pid = queue[0];
        const keyOf = {
          SJF: (q) => proc[q].burst,
          SRTF: (q) => tl.rem[q],
          PRIORITY: (q) => proc[q].priority,
          PRIORITYP: (q) => proc[q].priority,
          MLFQ: (q) => level[q],
        }[processAlgo];
        if (keyOf) {
          for (const q of queue) if (keyOf(q) < keyOf(pid)) pid = q;
        }
      }
      current[vm] = pid;
      const p = proc[pid];

      let extra = 0;
      if (features.caching) {
        if (cache.access(pid, vm)) stats[vm].cacheHits++;
        else {
          stats[vm].cacheMisses++;
          extra += CACHE_MISS_PENALTY;
        }
      }
      const demand = queue.reduce((s, q) => s + proc[q].memReq, 0);
      stats[vm].memoryUsed = Math.max(stats[vm].memoryUsed, demand);
      if (features.overcommit && demand > effectiveMemory[vm]) {
        stats[vm].overcommitEvents++;
        extra += PAGING_PENALTY;
      }
      if (features.numa && lastVM !== null && node[lastVM] !== node[vm]) {
        tl.penalty("NUMA", NUMA_PENALTY, `N${node[lastVM]}→N${node[vm]}`);
        stats[vm].numaHops++;
      }
      tl.switchTo(pid, vm, extra);
      lastVM = vm;

      let len = Math.min(tl.rem[pid], budget);
      const quantum = processAlgo === "MLFQ" ? processQuantum * 2 ** level[pid] : processQuantum;
      if (sliced) len = Math.min(len, quantum);
      // SRTF, preemptive priority and lower MLFQ levels give way when a new job arrives in this VM.
      if (processAlgo === "SRTF" || processAlgo === "PRIORITYP" || (processAlgo === "MLFQ" && level[pid] > 0)) {
        for (const other of processes) {
          if (other.arrival > tl.time && proc[other.pid].vm === vm) len = Math.min(len, other.arrival - tl.time);
        }
      }
      // User-defined I/O points: block after this many CPU units of the burst.
      const point = features.ioScheduling && p.ioTime > 0 ? (p.ioAt[ioIdx[pid] ?? 0] ?? null) : null;
      if (point !== null) len = Math.min(len, point - (p.burst - tl.rem[pid]));

      tl.run(pid, len, vm);
      budget -= len;
      stats[vm].cpuTime += len;
      credits[vm] -= len;
      (ranOn[vm] ??= new Set()).add(pid);

      if (tl.rem[pid] <= 0) {
        dequeue(vm, pid);
        delete current[vm];
        left--;
      } else if (point !== null && p.burst - tl.rem[pid] >= point) {
        ioIdx[pid] = (ioIdx[pid] ?? 0) + 1;
        ioQueue.push({ pid, vm, req: tl.time, dur: p.ioTime, prio: p.priority, seq: ioSeq++ });
        stats[vm].ioOperations++;
        dequeue(vm, pid);
        delete current[vm];
      } else if (sliced) {
        if (processAlgo === "MLFQ" && len >= quantum) level[pid] = Math.min(level[pid] + 1, 2);
        dequeue(vm, pid);
        queues[vm].push(pid);
      }
      admit();
    }
  }

  const total = tl.time;
  for (const name of vmNames) {
    const s = stats[name];
    s.processCount = ranOn[name]?.size ?? 0;
    s.idleTime = total - s.cpuTime;
    s.utilization = total > 0 ? (s.cpuTime / total) * 100 : 0;
  }
  const out = tl.results();
  for (const r of out.results) r.vm = proc[r.pid].vm;
  return {
    ...out,
    vmStats: vmNames.map((name) => stats[name]),
    totalMigrations: migrations.length,
    migrations,
    ioSchedule,
    cacheStats: features.caching ? cache.stats() : null,
    hypervisorFeatures: features,
  };
}

// Validates a request body like the PHP endpoint does and returns the same JSON shape.
export function simulateHypervisor(input) {
  const processAlgo = enumField(input.processAlgo, "processAlgo", ALGORITHMS, "FCFS");
  const processQuantum = intField(input.processQuantum, "processQuantum", 1, MAX_QUANTUM, 2);
  const vmScheduler = enumField(input.vmScheduler, "vmScheduler", VM_SCHEDULERS, "RR");
  const vmQuantum = intField(input.vmQuantum, "vmQuantum", 1, MAX_QUANTUM, 10);
  const csOverhead = overheadField(input.csOverhead);
  const migrationPenalty = intField(input.migrationPenalty, "migrationPenalty", 0, 100, 5);
  const mlfqBoost = intField(input.mlfqBoost, "mlfqBoost", 0, 10000, 0);
  const seed = intField(input.seed, "seed", 0, 2147483647, 42);
  const features = {
    migration: boolField(input.enableMigration ?? false),
    overcommit: boolField(input.enableOvercommit ?? false),
    ioScheduling: boolField(input.enableIOScheduling ?? false),
    caching: boolField(input.enableCaching ?? false),
    numa: boolField(input.enableNUMA ?? false),
  };
  const processes = validateProcesses(input.processes);
  const vms = validateVms(input.vms ?? [], processes);
  return schedule(vms, processes, processAlgo, processQuantum, vmScheduler, vmQuantum, csOverhead, migrationPenalty, mlfqBoost, seed, features);
}
