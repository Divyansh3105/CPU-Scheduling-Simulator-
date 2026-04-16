// Port of src/validation.php. Throws Error with the same messages the PHP endpoints return.
export const MAX_PROCESSES = 100;
export const MAX_VMS = 20;
export const MAX_ARRIVAL = 10000;
export const MAX_BURST = 1000;
export const MAX_QUANTUM = 1000;
export const NAME_RE = /^[A-Za-z0-9_.\- ]{1,32}$/;

const fail = (msg) => {
  throw new Error(msg);
};
const isNum = (v) => typeof v === "number" || (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)));

export function intField(value, name, min, max, def = null) {
  if (value === null || value === undefined || value === "") {
    if (def === null) fail(`${name} is required`);
    return def;
  }
  if (typeof value === "boolean" || !isNum(value) || !Number.isInteger(Number(value))) fail(`${name} must be an integer`);
  const n = Number(value);
  if (n < min || n > max) fail(`${name} must be between ${min} and ${max}`);
  return n;
}

export function overheadField(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === "boolean" || !isNum(value)) fail("csOverhead must be a number");
  const n = Number(value);
  if (n < 0 || n > 5 || (n * 2) % 1 !== 0) fail("csOverhead must be between 0 and 5 in steps of 0.5");
  return n;
}

export function nameField(value, name, def = null) {
  if ((value === null || value === undefined || value === "") && def !== null) return def;
  if (typeof value !== "string" && !Number.isInteger(value)) fail(`${name} must be a string`);
  const v = String(value).trim();
  if (!NAME_RE.test(v)) fail(`${name} must be 1-32 characters: letters, digits, space, _ . -`);
  return v;
}

export const boolField = (v) => v === true || v === 1 || v === "1" || v === "true";

export function enumField(value, name, allowed, def) {
  if (value === null || value === undefined || value === "") return def;
  const v = String(value).toUpperCase();
  if (!allowed.includes(v)) fail(`${name} must be one of: ${allowed.join(", ")}`);
  return v;
}

function ioPointsField(value, pid, burst, ioTime) {
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length)) {
    const half = Math.floor((burst + 1) / 2);
    return ioTime > 0 && half < burst ? [half] : [];
  }
  const items = typeof value === "string" ? value.trim().split(/\s*,\s*/) : value;
  if (!Array.isArray(items) || items.length > 10) fail(`${pid}.ioAt must list at most 10 points`);
  const points = items.map((item) => intField(item, `${pid}.ioAt`, 1, burst - 1 > 0 ? burst - 1 : 1));
  if (burst < 2) fail(`${pid}.ioAt needs a burst of at least 2`);
  return [...new Set(points)].sort((a, b) => a - b);
}

// Returns processes validated, normalised and sorted by arrival (stable, so ties keep input order).
export function validateProcesses(list) {
  if (!Array.isArray(list) || list.length === 0) fail("processes must be a non-empty array");
  if (list.length > MAX_PROCESSES) fail(`At most ${MAX_PROCESSES} processes are allowed`);
  const out = [];
  const seen = new Set();
  list.forEach((p, i) => {
    if (p === null || typeof p !== "object" || Array.isArray(p)) fail(`processes[${i}] must be an object`);
    const pid = nameField(p.pid, `processes[${i}].pid`);
    if (seen.has(pid)) fail(`Duplicate process ID: ${pid}`);
    seen.add(pid);
    const burst = intField(p.burst, `${pid}.burst`, 1, MAX_BURST);
    const ioTime = intField(p.ioTime, `${pid}.ioTime`, 0, MAX_BURST, 0);
    out.push({
      pid,
      arrival: intField(p.arrival, `${pid}.arrival`, 0, MAX_ARRIVAL),
      burst,
      priority: intField(p.priority, `${pid}.priority`, 1, 10, 5),
      ioTime,
      ioAt: ioPointsField(p.ioAt, pid, burst, ioTime),
      memReq: intField(p.memReq, `${pid}.memReq`, 1, 65536, 64),
      vm: nameField(p.vm, `${pid}.vm`, "Host"),
    });
  });
  return out.sort((a, b) => a.arrival - b.arrival);
}
