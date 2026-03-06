<?php
// Shared request handling for the simulator endpoints: headers, CORS, input validation.

ini_set('display_errors', '0');
error_reporting(E_ALL);

const MAX_BODY_BYTES = 65536;
const MAX_PROCESSES = 100;
const MAX_VMS = 20;
const MAX_ARRIVAL = 10000;
const MAX_BURST = 1000;
const MAX_QUANTUM = 1000;
const NAME_PATTERN = '/^[A-Za-z0-9_.\- ]{1,32}$/';

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');

// Same-origin by default. Set ALLOWED_ORIGIN to allow one cross-origin frontend.
$allowedOrigin = getenv('ALLOWED_ORIGIN');
if ($allowedOrigin && ($_SERVER['HTTP_ORIGIN'] ?? '') === $allowedOrigin) {
    header("Access-Control-Allow-Origin: $allowedOrigin");
    header('Vary: Origin');
    header('Access-Control-Allow-Methods: POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type');
}

$method = PHP_SAPI === 'cli' ? 'POST' : ($_SERVER['REQUEST_METHOD'] ?? 'GET'); // CLI: used by tests/check.php
if ($method === 'OPTIONS') {
    http_response_code(204);
    exit;
}
if ($method !== 'POST') {
    header('Allow: POST, OPTIONS');
    fail(405, 'Method not allowed');
}

function fail($status, $message)
{
    http_response_code($status);
    echo json_encode(['error' => $message]);
    exit;
}

function respond($data)
{
    echo json_encode($data);
    exit;
}

function read_input()
{
    $source = PHP_SAPI === 'cli' ? 'php://stdin' : 'php://input';
    $raw = file_get_contents($source, false, null, 0, MAX_BODY_BYTES + 1);
    if ($raw === false || strlen($raw) > MAX_BODY_BYTES) {
        fail(413, 'Request body too large');
    }
    $input = json_decode($raw, true);
    if (!is_array($input)) {
        fail(400, 'Invalid JSON input');
    }
    return $input;
}

function int_field($value, $name, $min, $max, $default = null)
{
    if ($value === null || $value === '') {
        if ($default === null) {
            fail(400, "$name is required");
        }
        return $default;
    }
    if (is_bool($value) || !is_numeric($value) || floor((float)$value) != (float)$value) {
        fail(400, "$name must be an integer");
    }
    $value = (int)$value;
    if ($value < $min || $value > $max) {
        fail(400, "$name must be between $min and $max");
    }
    return $value;
}

// Context switch overhead: 0-5 in steps of 0.5, so all simulated times stay exact in binary floats.
function overhead_field($value)
{
    if ($value === null) {
        return 0;
    }
    if (is_bool($value) || !is_numeric($value)) {
        fail(400, 'csOverhead must be a number');
    }
    $value = (float)$value;
    if ($value < 0 || $value > 5 || fmod($value * 2, 1) != 0) {
        fail(400, 'csOverhead must be between 0 and 5 in steps of 0.5');
    }
    return $value;
}

function name_field($value, $name, $default = null)
{
    if (($value === null || $value === '') && $default !== null) {
        return $default;
    }
    if (!is_string($value) && !is_int($value)) {
        fail(400, "$name must be a string");
    }
    $value = trim((string)$value);
    if (!preg_match(NAME_PATTERN, $value)) {
        fail(400, "$name must be 1-32 characters: letters, digits, space, _ . -");
    }
    return $value;
}

function bool_field($value)
{
    return $value === true || $value === 1 || $value === '1' || $value === 'true';
}

function enum_field($value, $name, $allowed, $default)
{
    if ($value === null || $value === '') {
        return $default;
    }
    $value = strtoupper((string)$value);
    if (!in_array($value, $allowed, true)) {
        fail(400, "$name must be one of: " . implode(', ', $allowed));
    }
    return $value;
}

// Returns processes validated, normalised and sorted by arrival (stable, so ties keep input order).
function validate_processes($list)
{
    if (!is_array($list) || !array_is_list($list) || count($list) === 0) {
        fail(400, 'processes must be a non-empty array');
    }
    if (count($list) > MAX_PROCESSES) {
        fail(400, 'At most ' . MAX_PROCESSES . ' processes are allowed');
    }

    $out = [];
    foreach ($list as $i => $p) {
        if (!is_array($p)) {
            fail(400, "processes[$i] must be an object");
        }
        $pid = name_field($p['pid'] ?? null, "processes[$i].pid");
        if (isset($out[$pid])) {
            fail(400, "Duplicate process ID: $pid");
        }
        $out[$pid] = [
            'pid' => $pid,
            'arrival' => int_field($p['arrival'] ?? null, "$pid.arrival", 0, MAX_ARRIVAL),
            'burst' => int_field($p['burst'] ?? null, "$pid.burst", 1, MAX_BURST),
            'priority' => int_field($p['priority'] ?? null, "$pid.priority", 1, 10, 5),
            'ioTime' => int_field($p['ioTime'] ?? null, "$pid.ioTime", 0, MAX_BURST, 0),
            'memReq' => int_field($p['memReq'] ?? null, "$pid.memReq", 1, 65536, 64),
            'vm' => name_field($p['vm'] ?? null, "$pid.vm", 'Host'),
        ];
    }

    $out = array_values($out);
    usort($out, fn($a, $b) => $a['arrival'] <=> $b['arrival']);
    return $out;
}

// Records what the CPU does over time and derives per-process metrics.
// Context switch rule (all algorithms): overhead is charged, and counted, whenever the CPU
// dispatches a different process than the one that ran last. The first dispatch is free.
class Timeline
{
    public $time = 0;
    public $segments = [];
    public $rem = [];
    public $first = [];
    public $finish = [];
    public $switches = [];
    private $last = null;
    private $procs;
    private $overhead;

    public function __construct(array $procs, $overhead)
    {
        $this->procs = $procs;
        $this->overhead = $overhead;
        foreach ($procs as $p) {
            $this->rem[$p['pid']] = $p['burst'];
            $this->switches[$p['pid']] = 0;
        }
    }

    public function idleUntil($t)
    {
        if ($t > $this->time) {
            $this->add('IDLE', $t, '');
        }
    }

    // $extra: additional dispatch cost (cache miss, paging) shown together with the switch overhead.
    public function switchTo($pid, $vm, $extra = 0)
    {
        $cost = $extra;
        if ($this->last !== null && $this->last !== $pid) {
            $this->switches[$pid]++;
            $cost += $this->overhead;
        }
        if ($cost > 0) {
            $this->add('CS', $this->time + $cost, $vm);
        }
        $this->last = $pid;
    }

    public function run($pid, $len, $vm)
    {
        $this->first[$pid] ??= $this->time;
        $this->add($pid, $this->time + $len, $vm);
        $this->rem[$pid] -= $len;
        if ($this->rem[$pid] <= 0) {
            $this->finish[$pid] = $this->time;
        }
    }

    public function penalty($label, $len, $vm)
    {
        if ($len > 0) {
            $this->add($label, $this->time + $len, $vm);
        }
    }

    private function add($pid, $end, $vm)
    {
        $n = count($this->segments);
        if ($n && $this->segments[$n - 1]['pid'] === $pid && $this->segments[$n - 1]['vm'] === $vm
            && $this->segments[$n - 1]['end'] == $this->time) {
            $this->segments[$n - 1]['end'] = $end;
        } else {
            $this->segments[] = ['pid' => $pid, 'start' => $this->time, 'end' => $end, 'vm' => $vm];
        }
        $this->time = $end;
    }

    public function results()
    {
        $results = [];
        foreach ($this->procs as $p) {
            $pid = $p['pid'];
            $turnaround = $this->finish[$pid] - $p['arrival'];
            $results[] = [
                'pid' => $pid,
                'vm' => $p['vm'],
                'arrival' => $p['arrival'],
                'burst' => $p['burst'],
                'completion' => $this->finish[$pid],
                'turnaround' => $turnaround,
                'waiting' => $turnaround - $p['burst'],
                'response' => $this->first[$pid] - $p['arrival'],
                'contextSwitches' => $this->switches[$pid],
            ];
        }
        return [
            'results' => $results,
            'segments' => $this->segments,
            'contextSwitches' => array_sum($this->switches),
        ];
    }
}
