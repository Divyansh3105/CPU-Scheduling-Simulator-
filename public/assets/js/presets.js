/* ---------------- Presets ---------------- */

export const PROCESS_PRESETS = {
  sample: [
    { pid: "P1", arrival: 0, burst: 5, priority: 2, ioTime: 1, memReq: 128 },
    { pid: "P2", arrival: 1, burst: 3, priority: 1, ioTime: 0, memReq: 64 },
    { pid: "P3", arrival: 2, burst: 8, priority: 3, ioTime: 2, memReq: 256 },
    { pid: "P4", arrival: 3, burst: 6, priority: 2, ioTime: 1, memReq: 128 },
  ],
  io: [
    { pid: "IO1", arrival: 0, burst: 4, priority: 3, ioTime: 3, memReq: 64 },
    { pid: "IO2", arrival: 1, burst: 3, priority: 4, ioTime: 4, memReq: 128 },
    { pid: "IO3", arrival: 2, burst: 5, priority: 3, ioTime: 3, memReq: 64 },
    { pid: "IO4", arrival: 3, burst: 2, priority: 5, ioTime: 5, memReq: 128 },
  ],
  cpu: [
    { pid: "CPU1", arrival: 0, burst: 10, priority: 1, ioTime: 0, memReq: 512 },
    { pid: "CPU2", arrival: 1, burst: 15, priority: 2, ioTime: 1, memReq: 256 },
    { pid: "CPU3", arrival: 2, burst: 12, priority: 1, ioTime: 0, memReq: 1024 },
    { pid: "CPU4", arrival: 3, burst: 8, priority: 3, ioTime: 1, memReq: 256 },
  ],
};

export const VM_PRESETS = {
  sample: [
    { name: "VM1", priority: 2, cpuShare: 40, memory: 1024, type: "compute" },
    { name: "VM2", priority: 5, cpuShare: 30, memory: 512, type: "standard" },
    { name: "VM3", priority: 8, cpuShare: 30, memory: 2048, type: "memory" },
  ],
  balanced: [
    { name: "Web-VM", priority: 3, cpuShare: 25, memory: 512, type: "standard" },
    { name: "DB-VM", priority: 1, cpuShare: 35, memory: 2048, type: "memory" },
    { name: "App-VM", priority: 2, cpuShare: 25, memory: 1024, type: "compute" },
    { name: "Cache-VM", priority: 4, cpuShare: 15, memory: 512, type: "realtime" },
  ],
};
