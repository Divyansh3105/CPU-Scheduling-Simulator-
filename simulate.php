<?php
error_reporting(E_ERROR | E_PARSE);
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST');
header('Access-Control-Allow-Headers: Content-Type');

$raw = file_get_contents("php://input");
$input = json_decode($raw, true);
if (!$input) {
    echo json_encode(['error' => 'Invalid input']);
    exit;
}

$algorithm = $input['algorithm'] ?? 'FCFS';
$quantum = isset($input['quantum']) ? intval($input['quantum']) : 2;
$processes = $input['processes'] ?? [];
$csOverhead = isset($input['csOverhead']) ? floatval($input['csOverhead']) : 0;

if (empty($processes)) {
    echo json_encode(['error' => 'No processes provided']);
    exit;
}

usort($processes, fn($a, $b) => ($a['arrival'] ?? 0) <=> ($b['arrival'] ?? 0));

function to_int($v)
{
    return intval($v);
}
function to_float($v)
{
    return floatval($v);
}

// FCFS Algorithm
function fcfs_algo($procs, $csOverhead = 0)
{
    $time = 0;
    $segments = [];
    $metrics = [];
    $contextSwitches = 0;
    $firstExecution = [];

    foreach ($procs as $p) {
        $arrival = to_int($p['arrival']);
        $burst = to_int($p['burst']);
        $pid = $p['pid'];

        if ($arrival > $time) {
            $segments[] = ['pid' => 'IDLE', 'start' => $time, 'end' => $arrival, 'vm' => ''];
            $time = $arrival;
        }

        $responseTime = $time - $arrival;
        $firstExecution[$pid] = $time;

        $time += $csOverhead;
        $start = $time;
        $end = $time + $burst;

        $segments[] = ['pid' => $pid, 'start' => $start, 'end' => $end, 'vm' => $p['vm'] ?? 'Host'];

        $metrics[$pid] = [
            'pid' => $pid,
            'vm' => $p['vm'] ?? 'Host',
            'arrival' => $arrival,
            'burst' => $burst,
            'completion' => $end,
            'turnaround' => $end - $arrival,
            'waiting' => $end - $arrival - $burst,
            'response' => $responseTime,
            'contextSwitches' => $contextSwitches
        ];

        $time = $end;
        $contextSwitches++;
    }

    return [
        'results' => array_values($metrics),
        'segments' => $segments,
        'contextSwitches' => $contextSwitches
    ];
}

// SJF Non-Preemptive
function sjf_algo($procs, $csOverhead = 0)
{
    $n = count($procs);
    $time = 0;
    $done = [];
    $segments = [];
    $metrics = [];
    $contextSwitches = 0;

    while (count($done) < $n) {
        $avail = array_filter($procs, function ($p) use ($time, $done) {
            return $p['arrival'] <= $time && !in_array($p['pid'], $done);
        });

        if (empty($avail)) {
            $next = PHP_INT_MAX;
            foreach ($procs as $p) {
                if (!in_array($p['pid'], $done)) {
                    $next = min($next, $p['arrival']);
                }
            }
            if ($next > $time) {
                $segments[] = ['pid' => 'IDLE', 'start' => $time, 'end' => $next, 'vm' => ''];
                $time = $next;
            }
            continue;
        }

        usort($avail, function ($a, $b) {
            return $a['burst'] <=> $b['burst'];
        });
        $p = $avail[0];

        $responseTime = $time - $p['arrival'];
        $time += $csOverhead;
        $start = $time;
        $end = $start + $p['burst'];

        $segments[] = ['pid' => $p['pid'], 'start' => $start, 'end' => $end, 'vm' => $p['vm'] ?? 'Host'];

        $metrics[$p['pid']] = [
            'pid' => $p['pid'],
            'vm' => $p['vm'] ?? 'Host',
            'arrival' => $p['arrival'],
            'burst' => $p['burst'],
            'completion' => $end,
            'turnaround' => $end - $p['arrival'],
            'waiting' => $end - $p['arrival'] - $p['burst'],
            'response' => $responseTime,
            'contextSwitches' => $contextSwitches
        ];

        $time = $end;
        $done[] = $p['pid'];
        $contextSwitches++;
    }

    return [
        'results' => array_values($metrics),
        'segments' => $segments,
        'contextSwitches' => $contextSwitches
    ];
}

// SRTF Preemptive
function srtf_algo($procs, $csOverhead = 0)
{
    $n = count($procs);
    $time = 0;
    $completed = 0;
    $segments = [];
    $rem = [];
    $firstExecution = [];
    $contextSwitchCount = [];

    foreach ($procs as $p) {
        $rem[$p['pid']] = $p['burst'];
        $firstExecution[$p['pid']] = -1;
        $contextSwitchCount[$p['pid']] = 0;
    }

    $lastPid = null;

    while ($completed < $n) {
        $avail = array_filter($procs, function ($p) use ($time, $rem) {
            return $p['arrival'] <= $time && $rem[$p['pid']] > 0;
        });

        if (empty($avail)) {
            $next = PHP_INT_MAX;
            foreach ($procs as $p) {
                if ($rem[$p['pid']] > 0) {
                    $next = min($next, $p['arrival']);
                }
            }
            if ($next > $time) {
                $segments[] = ['pid' => 'IDLE', 'start' => $time, 'end' => $next, 'vm' => ''];
                $time = $next;
                $lastPid = 'IDLE';
            }
            continue;
        }

        usort($avail, function ($a, $b) use ($rem) {
            return $rem[$a['pid']] <=> $rem[$b['pid']];
        });
        $cur = $avail[0];

        if ($firstExecution[$cur['pid']] === -1) {
            $firstExecution[$cur['pid']] = $time;
        }

        if ($lastPid !== $cur['pid']) {
            if ($lastPid !== null && $lastPid !== 'IDLE') {
                $time += $csOverhead;
            }
            $segments[] = [
                'pid' => $cur['pid'],
                'start' => $time,
                'end' => $time + 1,
                'vm' => $cur['vm'] ?? 'Host'
            ];
            $contextSwitchCount[$cur['pid']]++;
        } else {
            $segments[count($segments) - 1]['end'] = $time + 1;
        }

        $rem[$cur['pid']]--;
        if ($rem[$cur['pid']] == 0) {
            $completed++;
        }

        $lastPid = $cur['pid'];
        $time++;
    }

    $metrics = [];
    foreach ($procs as $p) {
        $segs = array_filter($segments, fn($s) => $s['pid'] == $p['pid']);
        $completion = empty($segs) ? $p['arrival'] : max(array_map(fn($s) => $s['end'], $segs));

        $metrics[] = [
            'pid' => $p['pid'],
            'vm' => $p['vm'] ?? 'Host',
            'arrival' => $p['arrival'],
            'burst' => $p['burst'],
            'completion' => $completion,
            'turnaround' => $completion - $p['arrival'],
            'waiting' => $completion - $p['arrival'] - $p['burst'],
            'response' => $firstExecution[$p['pid']] - $p['arrival'],
            'contextSwitches' => $contextSwitchCount[$p['pid']]
        ];
    }

    return [
        'results' => $metrics,
        'segments' => $segments,
        'contextSwitches' => array_sum($contextSwitchCount)
    ];
}

// Priority Scheduling
function priority_algo($procs, $csOverhead = 0)
{
    $n = count($procs);
    $time = 0;
    $done = [];
    $segments = [];
    $metrics = [];
    $contextSwitches = 0;

    while (count($done) < $n) {
        $avail = array_filter($procs, function ($p) use ($time, $done) {
            return $p['arrival'] <= $time && !in_array($p['pid'], $done);
        });

        if (empty($avail)) {
            $next = PHP_INT_MAX;
            foreach ($procs as $p) {
                if (!in_array($p['pid'], $done)) {
                    $next = min($next, $p['arrival']);
                }
            }
            if ($next > $time) {
                $segments[] = ['pid' => 'IDLE', 'start' => $time, 'end' => $next, 'vm' => ''];
                $time = $next;
            }
            continue;
        }

        usort($avail, function ($a, $b) {
            $pa = $a['priority'] ?? 9999;
            $pb = $b['priority'] ?? 9999;
            return $pa <=> $pb;
        });
        $p = $avail[0];

        $responseTime = $time - $p['arrival'];
        $time += $csOverhead;
        $start = $time;
        $end = $start + $p['burst'];

        $segments[] = ['pid' => $p['pid'], 'start' => $start, 'end' => $end, 'vm' => $p['vm'] ?? 'Host'];

        $metrics[$p['pid']] = [
            'pid' => $p['pid'],
            'vm' => $p['vm'] ?? 'Host',
            'arrival' => $p['arrival'],
            'burst' => $p['burst'],
            'completion' => $end,
            'turnaround' => $end - $p['arrival'],
            'waiting' => $end - $p['arrival'] - $p['burst'],
            'response' => $responseTime,
            'contextSwitches' => $contextSwitches
        ];

        $time = $end;
        $done[] = $p['pid'];
        $contextSwitches++;
    }

    return [
        'results' => array_values($metrics),
        'segments' => $segments,
        'contextSwitches' => $contextSwitches
    ];
}

// Round Robin
function rr_algo($procs, $quantum, $csOverhead = 0)
{
    $n = count($procs);
    $time = 0;
    $idx = 0;
    $rem = [];
    $firstExecution = [];
    $contextSwitchCount = [];

    foreach ($procs as $p) {
        $rem[$p['pid']] = $p['burst'];
        $firstExecution[$p['pid']] = -1;
        $contextSwitchCount[$p['pid']] = 0;
    }

    $queue = [];
    $segments = [];
    $finished = [];
    $completed = 0;

    while ($completed < $n) {
        while ($idx < $n && $procs[$idx]['arrival'] <= $time) {
            if ($rem[$procs[$idx]['pid']] > 0) {
                $queue[] = $procs[$idx];
            }
            $idx++;
        }

        if (empty($queue)) {
            if ($idx < $n) {
                $next = $procs[$idx]['arrival'];
                if ($next > $time) {
                    $segments[] = ['pid' => 'IDLE', 'start' => $time, 'end' => $next, 'vm' => ''];
                }
                $time = $next;
                continue;
            } else {
                break;
            }
        }

        $p = array_shift($queue);
        $pid = $p['pid'];

        if ($firstExecution[$pid] === -1) {
            $firstExecution[$pid] = $time;
        }

        $time += $csOverhead;
        $execTime = min($quantum, $rem[$pid]);

        $segments[] = [
            'pid' => $pid,
            'start' => $time,
            'end' => $time + $execTime,
            'vm' => $p['vm'] ?? 'Host'
        ];

        $rem[$pid] -= $execTime;
        $time += $execTime;
        $contextSwitchCount[$pid]++;

        while ($idx < $n && $procs[$idx]['arrival'] <= $time) {
            if ($rem[$procs[$idx]['pid']] > 0) {
                $queue[] = $procs[$idx];
            }
            $idx++;
        }

        if ($rem[$pid] > 0) {
            $queue[] = $p;
        } else {
            $completed++;
            $finished[$pid] = $time;
        }
    }

    $metrics = [];
    foreach ($procs as $p) {
        $completion = $finished[$p['pid']] ?? $p['arrival'];
        $metrics[] = [
            'pid' => $p['pid'],
            'vm' => $p['vm'] ?? 'Host',
            'arrival' => $p['arrival'],
            'burst' => $p['burst'],
            'completion' => $completion,
            'turnaround' => $completion - $p['arrival'],
            'waiting' => $completion - $p['arrival'] - $p['burst'],
            'response' => $firstExecution[$p['pid']] - $p['arrival'],
            'contextSwitches' => $contextSwitchCount[$p['pid']]
        ];
    }

    return [
        'results' => $metrics,
        'segments' => $segments,
        'contextSwitches' => array_sum($contextSwitchCount)
    ];
}

// MLFQ
function mlfq_algo($procs, $quantum, $csOverhead = 0)
{
    $n = count($procs);
    $time = 0;
    $idx = 0;

    $queues = [[], [], []];
    $quantums = [$quantum, $quantum * 2, $quantum * 4];
    $rem = [];
    $firstExecution = [];
    $contextSwitchCount = [];
    $queueLevel = [];

    foreach ($procs as $p) {
        $rem[$p['pid']] = $p['burst'];
        $firstExecution[$p['pid']] = -1;
        $contextSwitchCount[$p['pid']] = 0;
        $queueLevel[$p['pid']] = 0;
    }

    $segments = [];
    $completed = 0;

    while ($completed < $n) {
        while ($idx < $n && $procs[$idx]['arrival'] <= $time) {
            if ($rem[$procs[$idx]['pid']] > 0) {
                $queues[0][] = $procs[$idx];
            }
            $idx++;
        }

        $selectedQueue = -1;
        for ($i = 0; $i < 3; $i++) {
            if (!empty($queues[$i])) {
                $selectedQueue = $i;
                break;
            }
        }

        if ($selectedQueue === -1) {
            if ($idx < $n) {
                $next = $procs[$idx]['arrival'];
                $segments[] = ['pid' => 'IDLE', 'start' => $time, 'end' => $next, 'vm' => ''];
                $time = $next;
                continue;
            } else {
                break;
            }
        }

        $p = array_shift($queues[$selectedQueue]);

        if ($firstExecution[$p['pid']] === -1) {
            $firstExecution[$p['pid']] = $time;
        }

        $time += $csOverhead;
        $execTime = min($quantums[$selectedQueue], $rem[$p['pid']]);
        $segments[] = [
            'pid' => $p['pid'],
            'start' => $time,
            'end' => $time + $execTime,
            'vm' => $p['vm'] ?? 'Host'
        ];

        $rem[$p['pid']] -= $execTime;
        $time += $execTime;
        $contextSwitchCount[$p['pid']]++;

        while ($idx < $n && $procs[$idx]['arrival'] <= $time) {
            if ($rem[$procs[$idx]['pid']] > 0) {
                $queues[0][] = $procs[$idx];
            }
            $idx++;
        }

        if ($rem[$p['pid']] > 0) {
            $nextLevel = min($selectedQueue + 1, 2);
            $queues[$nextLevel][] = $p;
            $queueLevel[$p['pid']] = $nextLevel;
        } else {
            $completed++;
        }
    }

    $metrics = [];
    foreach ($procs as $p) {
        $segs = array_filter($segments, fn($s) => $s['pid'] == $p['pid']);
        $completion = empty($segs) ? $p['arrival'] : max(array_map(fn($s) => $s['end'], $segs));

        $metrics[] = [
            'pid' => $p['pid'],
            'vm' => $p['vm'] ?? 'Host',
            'arrival' => $p['arrival'],
            'burst' => $p['burst'],
            'completion' => $completion,
            'turnaround' => $completion - $p['arrival'],
            'waiting' => $completion - $p['arrival'] - $p['burst'],
            'response' => $firstExecution[$p['pid']] - $p['arrival'],
            'contextSwitches' => $contextSwitchCount[$p['pid']]
        ];
    }

    return [
        'results' => $metrics,
        'segments' => $segments,
        'contextSwitches' => array_sum($contextSwitchCount)
    ];
}

// Route to appropriate algorithm
$result = [];
switch (strtoupper($algorithm)) {
    case 'FCFS':
        $result = fcfs_algo($processes, $csOverhead);
        break;
    case 'SJF':
        $result = sjf_algo($processes, $csOverhead);
        break;
    case 'SRTF':
        $result = srtf_algo($processes, $csOverhead);
        break;
    case 'PRIORITY':
        $result = priority_algo($processes, $csOverhead);
        break;
    case 'RR':
        $result = rr_algo($processes, $quantum, $csOverhead);
        break;
    case 'MLFQ':
        $result = mlfq_algo($processes, $quantum, $csOverhead);
        break;
    default:
        $result = fcfs_algo($processes, $csOverhead);
        break;
}

echo json_encode($result, JSON_NUMERIC_CHECK);
