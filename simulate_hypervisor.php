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

$processAlgo = $input['processAlgo'] ?? 'FCFS';
$processQuantum = isset($input['processQuantum']) ? intval($input['processQuantum']) : 2;
$processes = $input['processes'] ?? [];
$vms = $input['vms'] ?? [];
$vmScheduler = $input['vmScheduler'] ?? 'RR';
$vmQuantum = isset($input['vmQuantum']) ? intval($input['vmQuantum']) : 10;
$csOverhead = isset($input['csOverhead']) ? floatval($input['csOverhead']) : 0;
$enableMigration = $input['enableMigration'] ?? false;
$enableOvercommit = $input['enableOvercommit'] ?? false;
$enableIOScheduling = $input['enableIOScheduling'] ?? false;
$enableCaching = $input['enableCaching'] ?? false;
$migrationPenalty = isset($input['migrationPenalty']) ? intval($input['migrationPenalty']) : 5;

if (empty($processes)) {
    echo json_encode(['error' => 'No processes provided']);
    exit;
}

// Sort processes by arrival time
usort($processes, fn($a, $b) => ($a['arrival'] ?? 0) <=> ($b['arrival'] ?? 0));

// ============================================
// ADVANCED HYPERVISOR FEATURES
// ============================================

// 1. VM LIVE MIGRATION
function migrate_process($process, $fromVM, $toVM, $time, $penalty)
{
    return [
        'process' => $process['pid'],
        'fromVM' => $fromVM,
        'toVM' => $toVM,
        'time' => $time,
        'penalty' => $penalty
    ];
}

// 2. LOAD BALANCING
function calculate_vm_load($vmName, $processes, $time)
{
    $activeProcs = array_filter($processes, function ($p) use ($vmName, $time) {
        return ($p['vm'] ?? 'Host') === $vmName &&
            $p['arrival'] <= $time &&
            ($p['remaining'] ?? $p['burst']) > 0;
    });

    $cpuLoad = array_sum(array_map(fn($p) => $p['remaining'] ?? $p['burst'], $activeProcs));
    $memoryLoad = array_sum(array_map(fn($p) => $p['memReq'] ?? 64, $activeProcs));

    return [
        'cpu' => $cpuLoad,
        'memory' => $memoryLoad,
        'processCount' => count($activeProcs)
    ];
}

// 3. RESOURCE OVERCOMMITMENT
function check_overcommit($vm, $totalMemoryUsed, $totalCPUUsed)
{
    $memoryLimit = $vm['memory'] ?? 512;
    $cpuLimit = ($vm['cpuShare'] ?? 25) / 100;

    return [
        'memoryOvercommit' => $totalMemoryUsed > $memoryLimit,
        'cpuOvercommit' => $totalCPUUsed > $cpuLimit,
        'memoryRatio' => $totalMemoryUsed / $memoryLimit,
        'cpuRatio' => $totalCPUUsed / $cpuLimit
    ];
}

// 4. CPU AFFINITY & PINNING
function assign_cpu_affinity($process, $vm)
{
    // Assign processes to specific virtual CPUs based on type
    $vmType = $vm['type'] ?? 'standard';

    if ($vmType === 'compute' || $vmType === 'realtime') {
        return ['affinity' => 'dedicated', 'vcpu' => 0];
    } elseif (($process['ioTime'] ?? 0) > 0) {
        return ['affinity' => 'io-optimized', 'vcpu' => 1];
    } else {
        return ['affinity' => 'shared', 'vcpu' => -1];
    }
}

// 5. MEMORY BALLOONING
function apply_memory_ballooning($vms, $processes)
{
    $totalSystemMemory = 8192; // 8GB total
    $allocatedMemory = array_sum(array_map(fn($v) => $v['memory'], $vms));

    if ($allocatedMemory > $totalSystemMemory) {
        $ratio = $totalSystemMemory / $allocatedMemory;
        foreach ($vms as &$vm) {
            $vm['actualMemory'] = floor($vm['memory'] * $ratio);
            $vm['balloonedMemory'] = $vm['memory'] - $vm['actualMemory'];
        }
    }

    return $vms;
}

// 6. I/O SCHEDULING with priorities
function schedule_io_operations($processes, $time)
{
    $ioOperations = [];

    foreach ($processes as $p) {
        if (($p['ioTime'] ?? 0) > 0 && isset($p['ioStartTime'])) {
            $ioOperations[] = [
                'pid' => $p['pid'],
                'vm' => $p['vm'],
                'ioTime' => $p['ioTime'],
                'priority' => $p['priority'] ?? 5,
                'startTime' => $p['ioStartTime']
            ];
        }
    }

    // Sort by priority (lower number = higher priority)
    usort($ioOperations, fn($a, $b) => $a['priority'] <=> $b['priority']);

    return $ioOperations;
}

// 7. CPU CACHING SIMULATION
class CPUCache
{
    private $cache = [];
    private $cacheSize = 8;
    private $hits = 0;
    private $misses = 0;

    public function access($pid, $vm)
    {
        $key = "$vm:$pid";

        if (isset($this->cache[$key])) {
            $this->hits++;
            // Move to end (LRU)
            unset($this->cache[$key]);
            $this->cache[$key] = true;
            return ['hit' => true, 'penalty' => 0];
        } else {
            $this->misses++;

            if (count($this->cache) >= $this->cacheSize) {
                array_shift($this->cache);
            }

            $this->cache[$key] = true;
            return ['hit' => false, 'penalty' => 2]; // Cache miss penalty
        }
    }

    public function getStats()
    {
        $total = $this->hits + $this->misses;
        return [
            'hits' => $this->hits,
            'misses' => $this->misses,
            'hitRate' => $total > 0 ? ($this->hits / $total) * 100 : 0
        ];
    }
}

// 8. CREDIT-BASED SCHEDULING
function credit_scheduler($vms, $time)
{
    static $credits = [];

    // Initialize credits
    foreach ($vms as $vm) {
        if (!isset($credits[$vm['name']])) {
            $credits[$vm['name']] = ($vm['cpuShare'] ?? 25) * 10;
        }
    }

    // Find VM with highest credits
    arsort($credits);
    $selectedVM = array_key_first($credits);

    // Deduct credits
    if ($selectedVM) {
        $credits[$selectedVM] -= 10;

        // Replenish credits periodically
        if ($time % 100 == 0) {
            foreach ($vms as $vm) {
                $credits[$vm['name']] += ($vm['cpuShare'] ?? 25) * 5;
            }
        }
    }

    return ['selectedVM' => $selectedVM, 'credits' => $credits];
}

// 9. LOTTERY SCHEDULING
function lottery_scheduler($vms)
{
    $totalTickets = array_sum(array_map(fn($v) => $v['cpuShare'] ?? 25, $vms));
    $winning = rand(1, $totalTickets);

    $cumulative = 0;
    foreach ($vms as $vm) {
        $cumulative += ($vm['cpuShare'] ?? 25);
        if ($winning <= $cumulative) {
            return $vm['name'];
        }
    }

    return $vms[0]['name'] ?? 'Host';
}

// 10. NUMA AWARENESS
function numa_node_assignment($vm)
{
    static $numaNodes = [0, 1];
    static $assignments = [];

    if (!isset($assignments[$vm['name']])) {
        // Assign based on VM type and priority
        $node = ($vm['priority'] ?? 5) % 2;
        $assignments[$vm['name']] = $node;
    }

    return [
        'numaNode' => $assignments[$vm['name']],
        'localMemory' => true,
        'crossNodePenalty' => 0
    ];
}

// ============================================
// MAIN HYPERVISOR SCHEDULING LOGIC
// ============================================

function enhanced_hypervisor_schedule(
    $vms,
    $processes,
    $vmScheduler,
    $vmQuantum,
    $processAlgo,
    $processQuantum,
    $csOverhead,
    $enableMigration,
    $enableOvercommit,
    $enableIOScheduling,
    $enableCaching,
    $migrationPenalty
) {

    $cache = new CPUCache();
    $migrations = [];
    $ioSchedule = [];
    $vmStats = [];
    $segments = [];
    $time = 0;

    // Apply memory ballooning if overcommit is enabled
    if ($enableOvercommit) {
        $vms = apply_memory_ballooning($vms, $processes);
    }

    // Initialize process states
    foreach ($processes as &$p) {
        $p['remaining'] = $p['burst'];
        $p['state'] = 'ready';
        $p['firstExecution'] = -1;
        $p['contextSwitches'] = 0;

        // Assign CPU affinity
        $vmData = array_filter($vms, fn($v) => $v['name'] === ($p['vm'] ?? 'Host'));
        if (!empty($vmData)) {
            $vm = reset($vmData);
            $p['affinity'] = assign_cpu_affinity($p, $vm);
        }
    }

    // Add host if needed
    $hostProcs = array_filter($processes, fn($p) => empty($p['vm']) || $p['vm'] === 'Host');
    if (!empty($hostProcs)) {
        $vms[] = ['name' => 'Host', 'priority' => 0, 'cpuShare' => 100, 'memory' => 4096, 'type' => 'standard'];
    }

    // Initialize VM stats
    foreach ($vms as $vm) {
        $vmStats[$vm['name']] = [
            'vm' => $vm['name'],
            'cpuTime' => 0,
            'idleTime' => 0,
            'processCount' => 0,
            'migrations' => 0,
            'memoryUsed' => 0,
            'utilization' => 0,
            'ioOperations' => 0,
            'cacheHits' => 0,
            'cacheMisses' => 0,
            'numaNode' => numa_node_assignment($vm)['numaNode'],
            'overcommitEvents' => 0
        ];
    }

    $completed = 0;
    $totalProcesses = count($processes);
    $lastVM = null;

    // Main scheduling loop
    while ($completed < $totalProcesses) {
        // I/O Scheduling
        if ($enableIOScheduling) {
            $ioOps = schedule_io_operations($processes, $time);
            if (!empty($ioOps)) {
                $ioSchedule = array_merge($ioSchedule, $ioOps);
            }
        }

        // VM Scheduler Selection
        $selectedVM = null;

        switch ($vmScheduler) {
            case 'CREDIT':
                $result = credit_scheduler($vms, $time);
                $selectedVM = $result['selectedVM'];
                break;

            case 'LOTTERY':
                $selectedVM = lottery_scheduler($vms);
                break;

            case 'PRIORITY':
                $activeVMs = array_filter($vms, function ($vm) use ($processes, $time) {
                    $vmProcs = array_filter(
                        $processes,
                        fn($p) => ($p['vm'] ?? 'Host') === $vm['name'] &&
                            $p['arrival'] <= $time &&
                            ($p['remaining'] ?? 0) > 0
                    );
                    return !empty($vmProcs);
                });

                if (!empty($activeVMs)) {
                    usort($activeVMs, fn($a, $b) => ($a['priority'] ?? 0) <=> ($b['priority'] ?? 0));
                    $selectedVM = $activeVMs[0]['name'];
                }
                break;

            case 'PROPORTIONAL':
            case 'RR':
            default:
                // Round-robin through active VMs
                foreach ($vms as $vm) {
                    $vmProcs = array_filter(
                        $processes,
                        fn($p) => ($p['vm'] ?? 'Host') === $vm['name'] &&
                            $p['arrival'] <= $time &&
                            ($p['remaining'] ?? 0) > 0
                    );
                    if (!empty($vmProcs)) {
                        $selectedVM = $vm['name'];
                        break;
                    }
                }
                break;
        }

        if (!$selectedVM) {
            // No VM has ready processes, advance time
            $nextArrival = PHP_INT_MAX;
            foreach ($processes as $p) {
                if (($p['remaining'] ?? 0) > 0 && $p['arrival'] > $time) {
                    $nextArrival = min($nextArrival, $p['arrival']);
                }
            }

            if ($nextArrival < PHP_INT_MAX) {
                $segments[] = ['pid' => 'IDLE', 'start' => $time, 'end' => $nextArrival, 'vm' => 'System'];
                $time = $nextArrival;
            } else {
                break;
            }
            continue;
        }

        // Get processes for selected VM
        $vmProcesses = array_filter(
            $processes,
            fn($p) => ($p['vm'] ?? 'Host') === $selectedVM &&
                $p['arrival'] <= $time &&
                ($p['remaining'] ?? 0) > 0
        );

        if (empty($vmProcesses)) {
            continue;
        }

        // Load balancing and migration
        if ($enableMigration && count($vmProcesses) > 5) {
            $targetVM = null;
            $minLoad = PHP_INT_MAX;

            foreach ($vms as $vm) {
                if ($vm['name'] !== $selectedVM) {
                    $load = calculate_vm_load($vm['name'], $processes, $time);
                    if ($load['processCount'] < $minLoad) {
                        $minLoad = $load['processCount'];
                        $targetVM = $vm['name'];
                    }
                }
            }

            if ($targetVM && $minLoad < count($vmProcesses) - 2) {
                // Migrate one process
                $processToMigrate = reset($vmProcesses);
                $migration = migrate_process($processToMigrate, $selectedVM, $targetVM, $time, $migrationPenalty);
                $migrations[] = $migration;

                // Update process VM assignment
                foreach ($processes as &$p) {
                    if ($p['pid'] === $processToMigrate['pid']) {
                        $p['vm'] = $targetVM;
                        $vmStats[$selectedVM]['migrations']++;
                        break;
                    }
                }

                // Add migration penalty
                $migrationLabel = $migration['fromVM'] . '→' . $migration['toVM'];
                $segments[] = ['pid' => 'MIGRATION', 'start' => $time, 'end' => $time + $migrationPenalty, 'vm' => $migrationLabel];
                $time += $migrationPenalty;
                continue;
            }
        }

        // Check for overcommit
        if ($enableOvercommit) {
            $vmData = array_filter($vms, fn($v) => $v['name'] === $selectedVM);
            $vm = reset($vmData);

            $totalMem = array_sum(array_map(fn($p) => $p['memReq'] ?? 64, $vmProcesses));
            $totalCPU = count($vmProcesses);

            $overcommit = check_overcommit($vm, $totalMem, $totalCPU);
            if ($overcommit['memoryOvercommit'] || $overcommit['cpuOvercommit']) {
                $vmStats[$selectedVM]['overcommitEvents']++;
            }
        }

        // Select process based on process algorithm
        $selectedProcess = null;

        switch (strtoupper($processAlgo)) {
            case 'SJF':
            case 'SRTF':
                usort($vmProcesses, fn($a, $b) => ($a['remaining'] ?? $a['burst']) <=> ($b['remaining'] ?? $b['burst']));
                $selectedProcess = reset($vmProcesses);
                break;

            case 'PRIORITY':
                usort($vmProcesses, fn($a, $b) => ($a['priority'] ?? 5) <=> ($b['priority'] ?? 5));
                $selectedProcess = reset($vmProcesses);
                break;

            case 'FCFS':
            case 'RR':
            case 'MLFQ':
            default:
                $selectedProcess = reset($vmProcesses);
                break;
        }

        if (!$selectedProcess) {
            continue;
        }

        // Apply CPU caching if enabled
        $cachePenalty = 0;
        if ($enableCaching) {
            $cacheResult = $cache->access($selectedProcess['pid'], $selectedVM);
            if ($cacheResult['hit']) {
                $vmStats[$selectedVM]['cacheHits']++;
            } else {
                $vmStats[$selectedVM]['cacheMisses']++;
                $cachePenalty = $cacheResult['penalty'];
            }
        }

        // Execute process
        if ($selectedProcess['firstExecution'] === -1) {
            $selectedProcess['firstExecution'] = $time;
        }

        $execTime = min($processQuantum, $selectedProcess['remaining']);

        // Add context switch overhead
        if ($lastVM !== $selectedVM) {
            $time += $csOverhead;
        }

        $time += $cachePenalty;

        $segments[] = [
            'pid' => $selectedProcess['pid'],
            'start' => $time,
            'end' => $time + $execTime,
            'vm' => $selectedVM
        ];

        // Update process state
        foreach ($processes as &$p) {
            if ($p['pid'] === $selectedProcess['pid']) {
                $p['remaining'] -= $execTime;
                $p['contextSwitches']++;

                if ($p['remaining'] <= 0) {
                    $p['completion'] = $time + $execTime;
                    $p['state'] = 'completed';
                    $completed++;
                }
                break;
            }
        }

        // Update VM stats
        $vmStats[$selectedVM]['cpuTime'] += $execTime;
        $vmStats[$selectedVM]['processCount'] = count($vmProcesses);

        $time += $execTime;
        $lastVM = $selectedVM;
    }

    // Calculate final metrics
    $results = [];
    foreach ($processes as $p) {
        $results[] = [
            'pid' => $p['pid'],
            'vm' => $p['vm'] ?? 'Host',
            'arrival' => $p['arrival'],
            'burst' => $p['burst'],
            'completion' => $p['completion'] ?? $time,
            'turnaround' => ($p['completion'] ?? $time) - $p['arrival'],
            'waiting' => (($p['completion'] ?? $time) - $p['arrival']) - $p['burst'],
            'response' => $p['firstExecution'] >= 0 ? $p['firstExecution'] - $p['arrival'] : 0,
            'contextSwitches' => $p['contextSwitches'],
            'affinity' => $p['affinity'] ?? null
        ];
    }

    // Finalize VM stats
    foreach ($vmStats as $vmName => &$stat) {
        if ($time > 0) {
            $stat['utilization'] = ($stat['cpuTime'] / $time) * 100;
            $stat['idleTime'] = $time - $stat['cpuTime'];
        }
    }

    $cacheStats = $enableCaching ? $cache->getStats() : null;

    return [
        'results' => $results,
        'segments' => $segments,
        'vmStats' => array_values($vmStats),
        'contextSwitches' => array_sum(array_map(fn($p) => $p['contextSwitches'], $processes)),
        'totalMigrations' => count($migrations),
        'migrations' => $migrations,
        'ioSchedule' => $ioSchedule,
        'cacheStats' => $cacheStats,
        'hypervisorFeatures' => [
            'migration' => $enableMigration,
            'overcommit' => $enableOvercommit,
            'ioScheduling' => $enableIOScheduling,
            'caching' => $enableCaching
        ]
    ];
}

$result = enhanced_hypervisor_schedule(
    $vms,
    $processes,
    $vmScheduler,
    $vmQuantum,
    $processAlgo,
    $processQuantum,
    $csOverhead,
    $enableMigration,
    $enableOvercommit,
    $enableIOScheduling,
    $enableCaching,
    $migrationPenalty
);

echo json_encode($result, JSON_NUMERIC_CHECK);
