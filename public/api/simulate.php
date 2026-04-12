<?php
require __DIR__ . '/../../src/bootstrap.php';

$input = read_input();
$algorithm = enum_field($input['algorithm'] ?? null, 'algorithm', ['FCFS', 'SJF', 'SRTF', 'PRIORITY', 'PRIORITYP', 'RR', 'MLFQ'], 'FCFS');
$quantum = int_field($input['quantum'] ?? null, 'quantum', 1, MAX_QUANTUM, 2);
$aging = int_field($input['aging'] ?? null, 'aging', 0, 1000, 0);           // 0 = off
$mlfqBoost = int_field($input['mlfqBoost'] ?? null, 'mlfqBoost', 0, 10000, 0); // 0 = off
$csOverhead = overhead_field($input['csOverhead'] ?? null);
$processes = validate_processes($input['processes'] ?? null);

// Earliest arrival still in the future among unfinished processes (INF if none).
function next_arrival(array $procs, Timeline $tl): int|float
{
    $next = INF;
    foreach ($procs as $p) {
        if ($tl->rem[$p['pid']] > 0 && $p['arrival'] > $tl->time) {
            $next = min($next, $p['arrival']);
        }
    }
    return $next;
}

// Aging: every $aging time units spent waiting improves a priority number by one (floor 1).
function effective_priority(int $base, int|float $waited, int $aging): int
{
    return $aging > 0 ? max(1, $base - intdiv((int)$waited, $aging)) : $base;
}

// FCFS / SJF / Priority: pick the ready process with the lowest $key($p, $now) and run it to completion.
// Ties go to the earliest arrival because $procs is sorted by arrival and the comparison is strict.
function run_nonpreemptive(array $procs, int|float $overhead, callable $key, string $reason): array
{
    $tl = new Timeline($procs, $overhead);
    $pending = $procs;
    while ($pending) {
        $best = null;
        foreach ($pending as $k => $p) {
            if ($p['arrival'] <= $tl->time && ($best === null || $key($p, $tl->time) < $key($pending[$best], $tl->time))) {
                $best = $k;
            }
        }
        if ($best === null) {
            $tl->idleUntil(reset($pending)['arrival']);
            continue;
        }
        $ready = [];
        foreach ($pending as $q) {
            if ($q['arrival'] <= $tl->time) {
                $ready[$q['pid']] = $key($q, $tl->time);
            }
        }
        $tl->decide($reason, $pending[$best]['pid'], $ready);
        $p = $pending[$best];
        unset($pending[$best]);
        $tl->switchTo($p['pid'], $p['vm']);
        $tl->run($p['pid'], $p['burst'], $p['vm']);
    }
    return $tl->results();
}

// SRTF: run the ready process with least remaining time until it finishes or the next arrival.
function run_srtf(array $procs, int|float $overhead): array
{
    $tl = new Timeline($procs, $overhead);
    $left = count($procs);
    $last = null;
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
        if ($pid !== $last) {
            $ready = [];
            foreach ($procs as $p) {
                if ($tl->rem[$p['pid']] > 0 && $p['arrival'] <= $tl->time) {
                    $ready[$p['pid']] = $tl->rem[$p['pid']];
                }
            }
            $tl->decide('least_remaining', $pid, $ready);
            $last = $pid;
        }
        $tl->switchTo($pid, $best['vm']);
        $tl->run($pid, min($tl->rem[$pid], next_arrival($procs, $tl) - $tl->time), $best['vm']);
        if ($tl->rem[$pid] <= 0) {
            $left--;
        }
    }
    return $tl->results();
}

// Preemptive priority: at every decision point the best effective priority runs. With aging the
// clock steps one unit at a time (ponytail: O(total burst x n); event-driven if bursts get huge).
// A running process keeps the CPU on ties, and its own wait clock resets whenever it runs.
function run_priority_preemptive(array $procs, int|float $overhead, int $aging): array
{
    $tl = new Timeline($procs, $overhead);
    $readySince = [];
    foreach ($procs as $p) {
        $readySince[$p['pid']] = $p['arrival'];
    }
    $left = count($procs);
    $last = null;
    while ($left) {
        $best = null;
        $bestKey = null;
        $lastKey = null;
        $ready = [];
        foreach ($procs as $p) {
            $pid = $p['pid'];
            if ($tl->rem[$pid] <= 0 || $p['arrival'] > $tl->time) {
                continue;
            }
            $key = effective_priority($p['priority'], $tl->time - $readySince[$pid], $aging);
            $ready[$pid] = $key;
            if ($pid === $last) {
                $lastKey = $key;
            }
            if ($best === null || $key < $bestKey) {
                $best = $p;
                $bestKey = $key;
            }
        }
        if ($best === null) {
            $tl->idleUntil(next_arrival($procs, $tl));
            continue;
        }
        if ($lastKey !== null && $lastKey === $bestKey) {
            $best = $procs[array_search($last, array_column($procs, 'pid'), true)];
        }
        $pid = $best['pid'];
        if ($pid !== $last) {
            $tl->decide('best_priority', $pid, $ready);
        }
        $len = min($tl->rem[$pid], next_arrival($procs, $tl) - $tl->time);
        if ($aging > 0) {
            $len = min($len, 1);
        }
        $tl->switchTo($pid, $best['vm']);
        $tl->run($pid, $len, $best['vm']);
        $readySince[$pid] = $tl->time;
        $last = $pid;
        if ($tl->rem[$pid] <= 0) {
            $left--;
        }
    }
    return $tl->results();
}

// Round Robin (one level) and MLFQ (several levels, demoted after using a full quantum).
// New arrivals join the top queue before the preempted process is re-queued.
// MLFQ extras: a slice below the top level ends when a new job arrives (the preempted job keeps its
// level and goes to the back of it), and every $boost time units all jobs return to the top level.
// The boost is checked when the CPU is next dispatched, not mid-slice.
function run_feedback(array $procs, int|float $overhead, array $quanta, int $boost = 0): array
{
    $tl = new Timeline($procs, $overhead);
    $queues = array_fill(0, count($quanta), []);
    $n = count($procs);
    $idx = 0;
    $left = $n;
    $nextBoost = $boost > 0 ? $boost : INF;
    $admit = function () use (&$idx, &$queues, $procs, $tl, $n) {
        while ($idx < $n && $procs[$idx]['arrival'] <= $tl->time) {
            $queues[0][] = $procs[$idx++];
        }
    };

    while ($left) {
        $admit();
        while ($tl->time >= $nextBoost) {
            for ($i = 1; $i < count($queues); $i++) {
                array_push($queues[0], ...$queues[$i]);
                $queues[$i] = [];
            }
            $nextBoost += $boost;
        }
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
        $ready = [$pid => $level];
        foreach ($queues as $i => $q) {
            foreach ($q as $w) {
                $ready[$w['pid']] = $i;
            }
        }
        $tl->decide('queue_front', $pid, $ready);
        $tl->switchTo($pid, $p['vm']);
        $admit();
        $len = min($quanta[$level], $tl->rem[$pid]);
        if ($level > 0 && $idx < $n) {
            $len = min($len, $procs[$idx]['arrival'] - $tl->time);
        }
        $tl->run($pid, $len, $p['vm']);
        $admit();

        if ($tl->rem[$pid] > 0) {
            $usedFullQuantum = $len >= $quanta[$level];
            $queues[$usedFullQuantum ? min($level + 1, count($quanta) - 1) : $level][] = $p;
        } else {
            $left--;
        }
    }
    return $tl->results();
}

respond(match ($algorithm) {
    'FCFS' => run_nonpreemptive($processes, $csOverhead, fn($p, $t) => $p['arrival'], 'first_arrived'),
    'SJF' => run_nonpreemptive($processes, $csOverhead, fn($p, $t) => $p['burst'], 'shortest_burst'),
    'PRIORITY' => run_nonpreemptive($processes, $csOverhead, fn($p, $t) => effective_priority($p['priority'], $t - $p['arrival'], $aging), 'best_priority'),
    'PRIORITYP' => run_priority_preemptive($processes, $csOverhead, $aging),
    'SRTF' => run_srtf($processes, $csOverhead),
    'RR' => run_feedback($processes, $csOverhead, [$quantum]),
    'MLFQ' => run_feedback($processes, $csOverhead, [$quantum, $quantum * 2, $quantum * 4], $mlfqBoost),
});
