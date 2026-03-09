<?php
require __DIR__ . '/common.php';

const ALGORITHMS = ['FCFS', 'SJF', 'SRTF', 'PRIORITY', 'RR', 'MLFQ'];
const VM_SCHEDULERS = ['RR', 'PRIORITY', 'PROPORTIONAL', 'CREDIT', 'LOTTERY'];
const VM_TYPES = ['standard', 'compute', 'memory', 'realtime'];
const TOTAL_SYSTEM_MEMORY = 8192; // MB of physical memory shared by all VMs
const CACHE_SIZE = 8;
const CACHE_MISS_PENALTY = 2;
const PAGING_PENALTY = 1;
const MIGRATION_IMBALANCE = 3; // migrate when a VM has this many more ready processes than another

$input = read_input();
$processAlgo = enum_field($input['processAlgo'] ?? null, 'processAlgo', ALGORITHMS, 'FCFS');
$processQuantum = int_field($input['processQuantum'] ?? null, 'processQuantum', 1, MAX_QUANTUM, 2);
$vmScheduler = enum_field($input['vmScheduler'] ?? null, 'vmScheduler', VM_SCHEDULERS, 'RR');
$vmQuantum = int_field($input['vmQuantum'] ?? null, 'vmQuantum', 1, MAX_QUANTUM, 10);
$csOverhead = overhead_field($input['csOverhead'] ?? null);
$migrationPenalty = int_field($input['migrationPenalty'] ?? null, 'migrationPenalty', 0, 100, 5);
$seed = int_field($input['seed'] ?? null, 'seed', 0, 2147483647, 42);
$features = [
    'migration' => bool_field($input['enableMigration'] ?? false),
    'overcommit' => bool_field($input['enableOvercommit'] ?? false),
    'ioScheduling' => bool_field($input['enableIOScheduling'] ?? false),
    'caching' => bool_field($input['enableCaching'] ?? false),
];
$processes = validate_processes($input['processes'] ?? null);
$vms = validate_vms($input['vms'] ?? [], $processes);

function validate_vms($list, $processes)
{
    if (!is_array($list) || !array_is_list($list)) {
        fail(400, 'vms must be an array');
    }
    if (count($list) > MAX_VMS) {
        fail(400, 'At most ' . MAX_VMS . ' VMs are allowed');
    }

    $vms = [];
    foreach ($list as $i => $v) {
        if (!is_array($v)) {
            fail(400, "vms[$i] must be an object");
        }
        $name = name_field($v['name'] ?? null, "vms[$i].name");
        if ($name === 'Host' || isset($vms[$name])) {
            fail(400, "Duplicate or reserved VM name: $name");
        }
        $type = $v['type'] ?? 'standard';
        if (!in_array($type, VM_TYPES, true)) {
            fail(400, "$name.type must be one of: " . implode(', ', VM_TYPES));
        }
        $vms[$name] = [
            'name' => $name,
            'priority' => int_field($v['priority'] ?? null, "$name.priority", 1, 10, 5),
            'cpuShare' => int_field($v['cpuShare'] ?? null, "$name.cpuShare", 1, 100, 25),
            'memory' => int_field($v['memory'] ?? null, "$name.memory", 128, 65536, 512),
            'type' => $type,
        ];
    }

    $usesHost = false;
    foreach ($processes as $p) {
        if ($p['vm'] === 'Host') {
            $usesHost = true;
        } elseif (!isset($vms[$p['vm']])) {
            fail(400, "Process {$p['pid']} is assigned to unknown VM {$p['vm']}");
        }
    }
    if ($usesHost) {
        $vms['Host'] = ['name' => 'Host', 'priority' => 0, 'cpuShare' => 100, 'memory' => 4096, 'type' => 'standard'];
    }
    return $vms;
}

// Informational only: which vCPU class a process would be pinned to.
function cpu_affinity($process, $vm)
{
    if ($vm['type'] === 'compute' || $vm['type'] === 'realtime') {
        return ['affinity' => 'dedicated', 'vcpu' => 0];
    }
    if ($process['ioTime'] > 0) {
        return ['affinity' => 'io-optimized', 'vcpu' => 1];
    }
    return ['affinity' => 'shared', 'vcpu' => -1];
}

// LRU cache of recently run (vm, pid) working sets.
class CPUCache
{
    private $cache = [];
    public $hits = 0;
    public $misses = 0;

    public function access($pid, $vm)
    {
        $key = "$vm:$pid";
        $hit = isset($this->cache[$key]);
        unset($this->cache[$key]);
        if (!$hit && count($this->cache) >= CACHE_SIZE) {
            array_shift($this->cache);
        }
        $this->cache[$key] = true;
        $hit ? $this->hits++ : $this->misses++;
        return $hit;
    }

    public function stats()
    {
        $total = $this->hits + $this->misses;
        return ['hits' => $this->hits, 'misses' => $this->misses, 'hitRate' => $total ? $this->hits / $total * 100 : 0];
    }
}

function hypervisor_schedule($vms, $processes, $processAlgo, $processQuantum, $vmScheduler, $vmQuantum,
                             $csOverhead, $migrationPenalty, $seed, $features)
{
    mt_srand($seed); // lottery draws are reproducible for the same input
    $tl = new Timeline($processes, $csOverhead);
    $cache = new CPUCache();
    $vmNames = array_keys($vms);

    // Memory ballooning: when overcommitted, every VM is squeezed proportionally into physical memory.
    $effectiveMemory = array_map(fn($v) => $v['memory'], $vms);
    $allocated = array_sum($effectiveMemory);
    if ($features['overcommit'] && $allocated > TOTAL_SYSTEM_MEMORY) {
        foreach ($effectiveMemory as &$m) {
            $m = (int)floor($m * TOTAL_SYSTEM_MEMORY / $allocated);
        }
        unset($m);
    }

    $proc = [];
    foreach ($processes as $p) {
        $proc[$p['pid']] = $p;
    }

    $stats = [];
    $credits = [];
    foreach ($vmNames as $i => $name) {
        $stats[$name] = [
            'vm' => $name,
            'cpuTime' => 0,
            'idleTime' => 0,
            'processCount' => 0,
            'migrations' => 0,
            'memoryUsed' => 0,
            'effectiveMemory' => $effectiveMemory[$name],
            'utilization' => 0,
            'ioOperations' => 0,
            'cacheHits' => 0,
            'cacheMisses' => 0,
            'numaNode' => $i % 2,
            'overcommitEvents' => 0,
        ];
        $credits[$name] = $vms[$name]['cpuShare'];
    }

    $queues = array_fill_keys($vmNames, []); // ready pids per VM, in queue order
    $current = [];                           // VM => pid holding the VM's CPU (non-preemptive algorithms)
    $blocked = [];                           // pid => time its I/O completes
    $ioDone = [];
    $deviceFree = 0;
    $ioSchedule = [];
    $migrations = [];
    $ranOn = [];
    $rrPos = -1;
    $n = count($processes);
    $idx = 0;
    $left = $n;
    $nonPreemptive = in_array($processAlgo, ['FCFS', 'SJF', 'PRIORITY'], true);
    $sliced = in_array($processAlgo, ['RR', 'MLFQ'], true);

    $admit = function () use (&$idx, &$queues, &$blocked, &$proc, $processes, $tl, $n) {
        while ($idx < $n && $processes[$idx]['arrival'] <= $tl->time) {
            $pid = $processes[$idx++]['pid'];
            $queues[$proc[$pid]['vm']][] = $pid;
        }
        asort($blocked);
        foreach ($blocked as $pid => $until) {
            if ($until > $tl->time) {
                break;
            }
            unset($blocked[$pid]);
            $queues[$proc[$pid]['vm']][] = $pid;
        }
    };
    $dequeue = function ($vm, $pid) use (&$queues) {
        $queues[$vm] = array_values(array_diff($queues[$vm], [$pid]));
    };

    while ($left) {
        $admit();
        $ready = array_values(array_filter($vmNames, fn($v) => $queues[$v]));

        if (!$ready) {
            $next = $blocked ? min($blocked) : INF;
            if ($idx < $n) {
                $next = min($next, $processes[$idx]['arrival']);
            }
            $tl->idleUntil($next);
            continue;
        }

        // --- VM level: choose which VM gets the CPU for the next slice ---
        switch ($vmScheduler) {
            case 'PRIORITY': // lower number = higher priority
                usort($ready, fn($a, $b) => $vms[$a]['priority'] <=> $vms[$b]['priority']);
                $vm = $ready[0];
                break;
            case 'PROPORTIONAL': // least CPU time received relative to its share
                usort($ready, fn($a, $b) => $stats[$a]['cpuTime'] / $vms[$a]['cpuShare'] <=> $stats[$b]['cpuTime'] / $vms[$b]['cpuShare']);
                $vm = $ready[0];
                break;
            case 'CREDIT': // spend credits while running; refill everyone when ready VMs run dry
                while (max(array_map(fn($v) => $credits[$v], $ready)) <= 0) {
                    foreach ($vmNames as $v) {
                        $credits[$v] = min($credits[$v] + $vms[$v]['cpuShare'], $vms[$v]['cpuShare']);
                    }
                }
                usort($ready, fn($a, $b) => $credits[$b] <=> $credits[$a]);
                $vm = $ready[0];
                break;
            case 'LOTTERY': // tickets = CPU share
                $draw = mt_rand(1, array_sum(array_map(fn($v) => $vms[$v]['cpuShare'], $ready)));
                foreach ($ready as $vm) {
                    $draw -= $vms[$vm]['cpuShare'];
                    if ($draw <= 0) {
                        break;
                    }
                }
                break;
            default: // RR: next VM after the previous one, in VM list order
                $count = count($vmNames);
                for ($i = 1; $i <= $count; $i++) {
                    $pos = ($rrPos + $i) % $count;
                    if ($queues[$vmNames[$pos]]) {
                        $vm = $vmNames[$pos];
                        $rrPos = $pos;
                        break;
                    }
                }
        }

        // --- Load balancing: move one waiting process to the least loaded guest VM ---
        if ($features['migration'] && $vm !== 'Host') {
            $target = null;
            foreach ($vmNames as $v) {
                if ($v !== $vm && $v !== 'Host' && ($target === null || count($queues[$v]) < count($queues[$target]))) {
                    $target = $v;
                }
            }
            if ($target !== null && count($queues[$vm]) - count($queues[$target]) >= MIGRATION_IMBALANCE) {
                $movable = array_values(array_diff($queues[$vm], [$current[$vm] ?? null]));
                $pid = end($movable);
                $dequeue($vm, $pid);
                $queues[$target][] = $pid;
                $proc[$pid]['vm'] = $target;
                $stats[$vm]['migrations']++;
                $migrations[] = ['process' => $pid, 'fromVM' => $vm, 'toVM' => $target, 'time' => $tl->time, 'penalty' => $migrationPenalty];
                $tl->penalty('MIGRATION', $migrationPenalty, "$vm→$target");
                continue;
            }
        }

        // --- Process level: run the VM's processes for up to vmQuantum time units ---
        $budget = $vmQuantum;
        while ($budget > 0 && $queues[$vm]) {
            $queue = $queues[$vm];
            if ($nonPreemptive && isset($current[$vm]) && in_array($current[$vm], $queue, true)) {
                $pid = $current[$vm];
            } else {
                $pid = $queue[0];
                $keyOf = match ($processAlgo) {
                    'SJF' => fn($q) => $proc[$q]['burst'],
                    'SRTF' => fn($q) => $tl->rem[$q],
                    'PRIORITY' => fn($q) => $proc[$q]['priority'],
                    default => null, // FCFS, RR, MLFQ: queue head
                };
                if ($keyOf) {
                    foreach ($queue as $q) {
                        if ($keyOf($q) < $keyOf($pid)) {
                            $pid = $q;
                        }
                    }
                }
            }
            $current[$vm] = $pid;
            $p = $proc[$pid];

            $extra = 0;
            if ($features['caching']) {
                if ($cache->access($pid, $vm)) {
                    $stats[$vm]['cacheHits']++;
                } else {
                    $stats[$vm]['cacheMisses']++;
                    $extra += CACHE_MISS_PENALTY;
                }
            }
            $demand = array_sum(array_map(fn($q) => $proc[$q]['memReq'], $queue));
            $stats[$vm]['memoryUsed'] = max($stats[$vm]['memoryUsed'], $demand);
            if ($features['overcommit'] && $demand > $effectiveMemory[$vm]) {
                $stats[$vm]['overcommitEvents']++;
                $extra += PAGING_PENALTY;
            }
            $tl->switchTo($pid, $vm, $extra);

            $len = min($tl->rem[$pid], $budget);
            if ($sliced) {
                // ponytail: MLFQ inside a VM behaves like RR; per-process levels if it ever matters
                $len = min($len, $processQuantum);
            }
            if ($processAlgo === 'SRTF') {
                foreach ($processes as $other) {
                    if ($other['arrival'] > $tl->time && $proc[$other['pid']]['vm'] === $vm) {
                        $len = min($len, $other['arrival'] - $tl->time);
                    }
                }
            }
            $cpuBeforeIO = intdiv($p['burst'] + 1, 2); // one I/O burst halfway through the CPU burst
            $wantsIO = $features['ioScheduling'] && $p['ioTime'] > 0 && empty($ioDone[$pid]);
            if ($wantsIO) {
                $len = min($len, $cpuBeforeIO - ($p['burst'] - $tl->rem[$pid]));
            }

            $tl->run($pid, $len, $vm);
            $budget -= $len;
            $stats[$vm]['cpuTime'] += $len;
            $credits[$vm] -= $len;
            $ranOn[$vm][$pid] = true;

            if ($tl->rem[$pid] <= 0) {
                $dequeue($vm, $pid);
                unset($current[$vm]);
                $left--;
            } elseif ($wantsIO && $p['burst'] - $tl->rem[$pid] >= $cpuBeforeIO) {
                // ponytail: single FCFS I/O device; a priority queue if contention modelling matters
                $start = max($deviceFree, $tl->time);
                $deviceFree = $start + $p['ioTime'];
                $blocked[$pid] = $deviceFree;
                $ioDone[$pid] = true;
                $ioSchedule[] = ['pid' => $pid, 'vm' => $vm, 'ioTime' => $p['ioTime'], 'priority' => $p['priority'], 'startTime' => $start];
                $stats[$vm]['ioOperations']++;
                $dequeue($vm, $pid);
                unset($current[$vm]);
            } elseif ($sliced) {
                $dequeue($vm, $pid);
                $queues[$vm][] = $pid;
            }
            $admit();
        }
    }

    $total = $tl->time;
    foreach ($stats as $name => &$s) {
        $s['processCount'] = count($ranOn[$name] ?? []);
        $s['idleTime'] = $total - $s['cpuTime'];
        $s['utilization'] = $total > 0 ? $s['cpuTime'] / $total * 100 : 0;
    }
    unset($s);

    $out = $tl->results();
    foreach ($out['results'] as &$r) {
        $r['vm'] = $proc[$r['pid']]['vm'];
        $r['affinity'] = cpu_affinity($proc[$r['pid']], $vms[$r['vm']]);
    }
    unset($r);

    return $out + [
        'vmStats' => array_values($stats),
        'totalMigrations' => count($migrations),
        'migrations' => $migrations,
        'ioSchedule' => $ioSchedule,
        'cacheStats' => $features['caching'] ? $cache->stats() : null,
        'hypervisorFeatures' => $features,
    ];
}

respond(hypervisor_schedule($vms, $processes, $processAlgo, $processQuantum, $vmScheduler, $vmQuantum,
    $csOverhead, $migrationPenalty, $seed, $features));
