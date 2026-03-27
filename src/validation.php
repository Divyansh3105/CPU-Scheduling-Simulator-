<?php
// Request field validation. Every function rejects bad input with fail() (HTTP 400).

function int_field(mixed $value, string $name, int $min, int $max, ?int $default = null): int
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
function overhead_field(mixed $value): int|float
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

function name_field(mixed $value, string $name, ?string $default = null): string
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

function bool_field(mixed $value): bool
{
    return $value === true || $value === 1 || $value === '1' || $value === 'true';
}

function enum_field(mixed $value, string $name, array $allowed, string $default): string
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

// I/O points: CPU time units into the burst at which a process blocks for its ioTime.
// Accepts an array or a comma-separated string; empty means "once, halfway through the burst".
function io_points_field(mixed $value, string $pid, int $burst, int $ioTime): array
{
    if ($value === null || $value === '' || $value === []) {
        $half = intdiv($burst + 1, 2);
        return $ioTime > 0 && $half < $burst ? [$half] : [];
    }
    $items = is_string($value) ? preg_split('/\s*,\s*/', trim($value)) : $value;
    if (!is_array($items) || count($items) > 10) {
        fail(400, "$pid.ioAt must list at most 10 points");
    }
    $points = [];
    foreach ($items as $item) {
        $points[] = int_field($item, "$pid.ioAt", 1, $burst - 1 > 0 ? $burst - 1 : 1);
    }
    if ($burst < 2) {
        fail(400, "$pid.ioAt needs a burst of at least 2");
    }
    $points = array_values(array_unique($points));
    sort($points);
    return $points;
}

// Returns processes validated, normalised and sorted by arrival (stable, so ties keep input order).
function validate_processes(mixed $list): array
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
        $burst = int_field($p['burst'] ?? null, "$pid.burst", 1, MAX_BURST);
        $ioTime = int_field($p['ioTime'] ?? null, "$pid.ioTime", 0, MAX_BURST, 0);
        $out[$pid] = [
            'pid' => $pid,
            'arrival' => int_field($p['arrival'] ?? null, "$pid.arrival", 0, MAX_ARRIVAL),
            'burst' => $burst,
            'priority' => int_field($p['priority'] ?? null, "$pid.priority", 1, 10, 5),
            'ioTime' => $ioTime,
            'ioAt' => io_points_field($p['ioAt'] ?? null, $pid, $burst, $ioTime),
            'memReq' => int_field($p['memReq'] ?? null, "$pid.memReq", 1, 65536, 64),
            'vm' => name_field($p['vm'] ?? null, "$pid.vm", 'Host'),
        ];
    }

    $out = array_values($out);
    usort($out, fn($a, $b) => $a['arrival'] <=> $b['arrival']);
    return $out;
}
