// Cross-check: the JavaScript engine must return exactly what the PHP endpoints return.
// Run: node tests/parity.mjs [cases]   (needs `php` on PATH)
import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { simulate } from "../public/assets/js/engine/simulate.js";
import { simulateHypervisor } from "../public/assets/js/engine/hypervisor.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const php = (endpoint, payload) => {
  const r = spawnSync("php", [`${root}public/api/${endpoint}`], { input: JSON.stringify(payload), encoding: "utf8", maxBuffer: 1 << 28 });
  return JSON.parse(r.stdout);
};

// Small deterministic PRNG so failures are reproducible.
let s = 12345;
const rnd = (n) => {
  s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
  return s % n;
};
const pick = (a) => a[rnd(a.length)];

function workload(withVms) {
  const vms = withVms
    ? ["A", "B", "3", "D"].slice(0, 2 + rnd(3)).map((name) => ({
        name, priority: 1 + rnd(5), cpuShare: 10 + rnd(40), memory: pick([512, 2048, 4096]), type: pick(["compute", "memory", "realtime", "standard"]),
      }))
    : [];
  const n = 1 + rnd(9);
  const processes = Array.from({ length: n }, (_, i) => {
    const burst = 1 + rnd(12);
    return {
      pid: i % 4 === 3 ? String(i) : `P${i}`, arrival: rnd(15), burst, priority: 1 + rnd(5), ioTime: rnd(3) ? rnd(4) : 0,
      ioAt: rnd(3) === 0 && burst > 3 ? [1 + rnd(burst - 1)] : [], memReq: pick([64, 256, 1024, 3000]),
      vm: vms.length && rnd(5) ? pick(vms).name : "Host",
    };
  });
  return { processes, vms };
}

let failures = 0;
let total = 0;
const compare = (label, endpoint, payload, run) => {
  total++;
  let js;
  try { js = JSON.parse(JSON.stringify(run(payload))); } catch (e) { js = { error: e.message }; }
  const ref = php(endpoint, payload);
  if (!isDeepStrictEqual(js, ref)) {
    failures++;
    console.log(`MISMATCH ${label}\n${JSON.stringify(payload)}`);
  }
};

const cases = Number(process.argv[2]) || 150;
for (let i = 0; i < cases; i++) {
  const { processes } = workload(false);
  compare(`simulate #${i}`, "simulate.php", {
    algorithm: pick(["FCFS", "SJF", "SRTF", "PRIORITY", "PRIORITYP", "RR", "MLFQ"]), quantum: 1 + rnd(4),
    aging: pick([0, 0, 2, 5]), mlfqBoost: pick([0, 0, 6, 15]), csOverhead: pick([0, 0.5, 1, 2]), processes,
  }, simulate);
}
for (let i = 0; i < cases; i++) {
  const { processes, vms } = workload(true);
  compare(`hypervisor #${i}`, "simulate_hypervisor.php", {
    processAlgo: pick(["FCFS", "SJF", "SRTF", "PRIORITY", "PRIORITYP", "RR", "MLFQ"]), processQuantum: 1 + rnd(4),
    mlfqBoost: pick([0, 0, 8]), vmScheduler: pick(["RR", "PRIORITY", "PROPORTIONAL", "CREDIT", "LOTTERY"]), vmQuantum: 1 + rnd(8),
    csOverhead: pick([0, 0.5, 1]), migrationPenalty: rnd(6), seed: rnd(1000),
    enableMigration: !!rnd(2), enableOvercommit: !!rnd(2), enableIOScheduling: !!rnd(2), enableCaching: !!rnd(2), enableNUMA: !!rnd(2),
    processes, vms,
  }, simulateHypervisor);
}
// Validation errors must match too.
compare("bad algorithm", "simulate.php", { algorithm: "NOPE", processes: workload(false).processes }, simulate);
compare("no processes", "simulate.php", { processes: [] }, simulate);
const P = (pid, burst = 2, extra = {}) => ({ pid, arrival: 0, burst, ...extra });
compare("__proto__ pid", "simulate.php", { processes: [P("__proto__")] }, simulate);
compare("__proto__ vm", "simulate_hypervisor.php", { processes: [P("X", 2, { vm: "__proto__" })], vms: [{ name: "__proto__" }] }, simulateHypervisor);
// Names that exist on every plain JS object must behave like any other name.
for (const n of ["constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf"]) {
  const ps = [P(n, 3, { ioTime: 1 }), P("B", 2, { arrival: 1 })];
  for (const algorithm of ["FCFS", "SRTF", "RR", "MLFQ"]) compare(`pid ${n} ${algorithm}`, "simulate.php", { algorithm, processes: ps }, simulate);
  compare(`vm ${n}`, "simulate_hypervisor.php", { processes: [P("A", 4, { vm: n })], vms: [{ name: n }], enableIOScheduling: true }, simulateHypervisor);
  compare(`vm+pid ${n}`, "simulate_hypervisor.php", { processes: [P(n, 4, { vm: n, ioTime: 2 })], vms: [{ name: n }], enableIOScheduling: true, enableCaching: true }, simulateHypervisor);
}
compare("hex number", "simulate.php", { processes: [{ pid: "X", arrival: 0, burst: "0x1A" }] }, simulate);
compare("total burst cap", "simulate.php", { processes: Array.from({ length: 21 }, (_, i) => P("P" + i, 1000)) }, simulate);
const big = Array.from({ length: 20 }, (_, i) => P("P" + i, 1000, { vm: i % 2 ? "A" : "B", ioTime: 3 }));
compare("largest allowed RR", "simulate.php", { algorithm: "RR", quantum: 1, csOverhead: 5, processes: big }, simulate);
compare("largest allowed hypervisor", "simulate_hypervisor.php", { processAlgo: "RR", processQuantum: 1, vmQuantum: 1, csOverhead: 5, enableIOScheduling: true, enableCaching: true, enableNUMA: true, processes: big, vms: [{ name: "A" }, { name: "B" }] }, simulateHypervisor);
compare("unknown vm", "simulate_hypervisor.php", { processes: [{ pid: "X", arrival: 0, burst: 2, vm: "Ghost" }], vms: [] }, simulateHypervisor);

console.log(failures ? `\n${failures} of ${total} cases differ` : `\nAll ${total} cases match PHP`);
process.exit(failures ? 1 : 0);
