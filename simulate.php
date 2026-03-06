<?php
require __DIR__ . '/common.php';

$input = read_input();
$algorithm = enum_field($input['algorithm'] ?? null, 'algorithm', ['FCFS', 'SJF', 'SRTF', 'PRIORITY', 'RR', 'MLFQ'], 'FCFS');
$quantum = int_field($input['quantum'] ?? null, 'quantum', 1, MAX_QUANTUM, 2);
$csOverhead = overhead_field($input['csOverhead'] ?? null);
$processes = validate_processes($input['processes'] ?? null);

// Earliest arrival still in the future among unfinished processes (INF if none).
function next_arrival($procs, Timeline $tl)
{
    $next = INF;
    foreach ($procs as $p) {
        if ($tl->rem[$p['pid']] > 0 && $p['arrival'] > $tl->time) {
            $next = min($next, $p['arrival']);
        }
    }
    return $next;
}

// FCFS / SJF / Priority: pick the ready process with the lowest $key and run it to completion.
// Ties go to the earliest arrival because $procs is sorted by arrival and the comparison is strict.
function run_nonpreemptive($procs, $overhead, $key)
{
    $tl = new Timeline($procs, $overhead);
    $pending = $procs;
    while ($pending) {
        $best = null;
        foreach ($pending as $k => $p) {
            if ($p['arrival'] <= $tl->time && ($best === null || $key($p) < $key($pending[$best]))) {
                $best = $k;
            }
        }
        if ($best === null) {
            $tl->idleUntil(reset($pending)['arrival']);
            continue;
        }
        $p = $pending[$best];
        unset($pending[$best]);
        $tl->switchTo($p['pid'], $p['vm']);
        $tl->run($p['pid'], $p['burst'], $p['vm']);
    }
    return $tl->results();
}

// SRTF: run the ready process with least remaining time until it finishes or the next arrival.
function run_srtf($procs, $overhead)
{
    $tl = new Timeline($procs, $overhead);
    $left = count($procs);
    while ($left) {
        $best = null;
        foreach ($procs as $p) {
            $rem = $tl->rem[$p['pid']];
            if ($rem > 0 && $p['arrival'] <= $tl->time && ($best === null || $rem < $tl->rem[$best['pid']])) {
                $best = $p;
            }
        }
        if ($best === null) {
            $tl->idleUntil(next_arrival($procs, $tl));
            continue;
        }
        $pid = $best['pid'];
        $tl->switchTo($pid, $best['vm']);
        $tl->run($pid, min($tl->rem[$pid], next_arrival($procs, $tl) - $tl->time), $best['vm']);
        if ($tl->rem[$pid] <= 0) {
            $left--;
        }
    }
    return $tl->results();
}

// Round Robin (one level) and MLFQ (several levels, demoted after using a full quantum).
// New arrivals join the top queue before the preempted process is re-queued.
function run_feedback($procs, $overhead, $quanta)
{
    $tl = new Timeline($procs, $overhead);
    $queues = array_fill(0, count($quanta), []);
    $n = count($procs);
    $idx = 0;
    $left = $n;
    $admit = function () use (&$idx, &$queues, $procs, $tl, $n) {
        while ($idx < $n && $procs[$idx]['arrival'] <= $tl->time) {
            $queues[0][] = $procs[$idx++];
        }
    };

    while ($left) {
        $admit();
        $level = null;
        foreach ($queues as $i => $q) {
            if ($q) {
                $level = $i;
                break;
            }
        }
        if ($level === null) {
            $tl->idleUntil($procs[$idx]['arrival']);
            continue;
        }

        $p = array_shift($queues[$level]);
        $pid = $p['pid'];
        $tl->switchTo($pid, $p['vm']);
        $admit();
        $tl->run($pid, min($quanta[$level], $tl->rem[$pid]), $p['vm']);
        $admit();

        if ($tl->rem[$pid] > 0) {
            $queues[min($level + 1, count($quanta) - 1)][] = $p;
        } else {
            $left--;
        }
    }
    return $tl->results();
}

respond(match ($algorithm) {
    'FCFS' => run_nonpreemptive($processes, $csOverhead, fn($p) => 0),
    'SJF' => run_nonpreemptive($processes, $csOverhead, fn($p) => $p['burst']),
    'PRIORITY' => run_nonpreemptive($processes, $csOverhead, fn($p) => $p['priority']),
    'SRTF' => run_srtf($processes, $csOverhead),
    'RR' => run_feedback($processes, $csOverhead, [$quantum]),
    'MLFQ' => run_feedback($processes, $csOverhead, [$quantum, $quantum * 2, $quantum * 4]),
});
