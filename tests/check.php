<?php
// Self-check for both endpoints. Run: php tests/check.php
// Expected values are hand-computed textbook schedules.

if (PHP_SAPI !== 'cli') { // never runnable through a web server
    http_response_code(404);
    exit;
}

$root = dirname(__DIR__);
require $root . '/src/bootstrap.php'; // for rate_limit_allow(); in the CLI it sends no headers and reads no input
$failures = 0;

function call(string $endpoint, array|string $payload): array
{
    global $root;
    $proc = proc_open([PHP_BINARY, "$root/public/api/$endpoint"], [['pipe', 'r'], ['pipe', 'w'], ['pipe', 'w']], $pipes);
    fwrite($pipes[0], is_string($payload) ? $payload : json_encode($payload));
    fclose($pipes[0]);
    $out = stream_get_contents($pipes[1]);
    $err = stream_get_contents($pipes[2]);
    proc_close($proc);
    $data = json_decode($out, true);
    if (!is_array($data)) {
        throw new RuntimeException("$endpoint returned non-JSON: $out $err");
    }
    return $data;
}

function check(string $name, mixed $cond): void
{
    global $failures;
    echo ($cond ? 'ok   ' : 'FAIL ') . $name . "\n";
    if (!$cond) {
        $failures++;
    }
}

function by_pid(array $data, string $field): array
{
    return array_column($data['results'], $field, 'pid');
}

function procs(array $rows): array
{
    return array_map(fn($r) => ['pid' => $r[0], 'arrival' => $r[1], 'burst' => $r[2], 'priority' => $r[3] ?? 5, 'vm' => $r[4] ?? 'Host', 'ioTime' => $r[5] ?? 0, 'ioAt' => $r[6] ?? []], $rows);
}

$abc = procs([['A', 0, 5, 2], ['B', 1, 3, 1], ['C', 20, 2, 1]]);

// --- simulate.php ---
$d = call('simulate.php', ['algorithm' => 'FCFS', 'processes' => $abc, 'csOverhead' => 0]);
check('FCFS completion', by_pid($d, 'completion') == ['A' => 5, 'B' => 8, 'C' => 22]);
check('FCFS waiting', by_pid($d, 'waiting') == ['A' => 0, 'B' => 4, 'C' => 0]);
check('FCFS switches', $d['contextSwitches'] === 2 && by_pid($d, 'contextSwitches') == ['A' => 0, 'B' => 1, 'C' => 1]);

$d = call('simulate.php', ['algorithm' => 'FCFS', 'processes' => $abc, 'csOverhead' => 1]);
check('FCFS overhead completion', by_pid($d, 'completion') == ['A' => 5, 'B' => 9, 'C' => 23]);
check('FCFS overhead response', by_pid($d, 'response') == ['A' => 0, 'B' => 5, 'C' => 1]);
check('FCFS overhead CS segments', count(array_filter($d['segments'], fn($s) => $s['pid'] === 'CS')) === 2);

$d = call('simulate.php', ['algorithm' => 'SJF', 'processes' => procs([['A', 0, 7], ['B', 2, 4], ['C', 4, 1], ['D', 5, 4]])]);
check('SJF completion', by_pid($d, 'completion') == ['A' => 7, 'B' => 12, 'C' => 8, 'D' => 16]);

$d = call('simulate.php', ['algorithm' => 'SRTF', 'processes' => procs([['P1', 0, 8], ['P2', 1, 4], ['P3', 2, 9], ['P4', 3, 5]])]);
check('SRTF completion', by_pid($d, 'completion') == ['P1' => 17, 'P2' => 5, 'P3' => 26, 'P4' => 10]);
check('SRTF avg waiting 6.5', array_sum(by_pid($d, 'waiting')) / 4 == 6.5);

$d = call('simulate.php', ['algorithm' => 'PRIORITY', 'processes' => procs([['A', 0, 5, 2], ['B', 1, 3, 1], ['C', 1, 1, 1]])]);
check('Priority tie keeps arrival order', by_pid($d, 'completion') == ['A' => 5, 'B' => 8, 'C' => 9]);

$d = call('simulate.php', ['algorithm' => 'RR', 'quantum' => 2, 'processes' => procs([['P1', 0, 5], ['P2', 1, 3], ['P3', 2, 1]])]);
check('RR completion', by_pid($d, 'completion') == ['P1' => 9, 'P2' => 8, 'P3' => 5]);

$d = call('simulate.php', ['algorithm' => 'MLFQ', 'quantum' => 1, 'processes' => procs([['A', 0, 7]])]);
check('MLFQ single process', by_pid($d, 'completion') == ['A' => 7] && $d['contextSwitches'] === 0 && count($d['segments']) === 1);

$big = procs(array_map(fn($i) => ["P$i", $i, 1000], range(1, 100)));
$t = microtime(true);
$d = call('simulate.php', ['algorithm' => 'SRTF', 'processes' => $big]);
check('SRTF 100 x 1000 is fast', !isset($d['error']) && microtime(true) - $t < 5);

$rejects = [
    'quantum 0' => ['algorithm' => 'RR', 'quantum' => 0, 'processes' => $abc],
    'negative quantum' => ['algorithm' => 'MLFQ', 'quantum' => -1, 'processes' => $abc],
    'duplicate pid' => ['algorithm' => 'SJF', 'processes' => procs([['A', 0, 3], ['A', 1, 2]])],
    'zero burst' => ['algorithm' => 'SRTF', 'processes' => procs([['A', 0, 0]])],
    'huge burst' => ['algorithm' => 'SRTF', 'processes' => procs([['A', 0, 99999999]])],
    'missing fields' => ['algorithm' => 'FCFS', 'processes' => [['pid' => 'A']]],
    'string processes' => ['algorithm' => 'FCFS', 'processes' => 'x'],
    'html in pid' => ['algorithm' => 'FCFS', 'processes' => procs([['<img src=x onerror=alert(1)>', 0, 1]])],
    'bad overhead step' => ['algorithm' => 'FCFS', 'processes' => $abc, 'csOverhead' => 0.3],
    'unknown algorithm' => ['algorithm' => 'NOPE', 'processes' => $abc],
    'too many processes' => ['algorithm' => 'FCFS', 'processes' => procs(array_map(fn($i) => ["P$i", 0, 1], range(1, 101)))],
];
foreach ($rejects as $name => $payload) {
    check("rejects $name", isset(call('simulate.php', $payload)['error']));
}
check('rejects invalid JSON', isset(call('simulate.php', '{nope')['error']));

// --- simulate_hypervisor.php ---
$vm = fn($name, $extra = []) => $extra + ['name' => $name, 'priority' => 5, 'cpuShare' => 25, 'memory' => 512, 'type' => 'standard'];
$hv = fn($payload) => call('simulate_hypervisor.php', $payload + ['csOverhead' => 0, 'processAlgo' => 'FCFS']);

$d = $hv(['vms' => [$vm('VM1'), $vm('VM2')], 'vmScheduler' => 'RR', 'vmQuantum' => 2,
    'processes' => procs([['A', 0, 4, 5, 'VM1'], ['B', 0, 4, 5, 'VM2']])]);
check('HV keeps every process once', array_column($d['results'], 'pid') == ['A', 'B']);
check('HV RR alternates VMs per slice', by_pid($d, 'completion') == ['A' => 6, 'B' => 8]);
check('HV switch count', $d['contextSwitches'] === 3);

$d = $hv(['vms' => [$vm('VM1', ['priority' => 5]), $vm('VM2', ['priority' => 1])], 'vmScheduler' => 'PRIORITY',
    'processes' => procs([['A', 0, 3, 5, 'VM1'], ['B', 0, 3, 5, 'VM2']])]);
check('HV priority runs higher-priority VM first', by_pid($d, 'completion') == ['A' => 6, 'B' => 3]);

$d = $hv(['vms' => [$vm('VM1', ['cpuShare' => 75]), $vm('VM2', ['cpuShare' => 25])], 'vmScheduler' => 'PROPORTIONAL', 'vmQuantum' => 1,
    'processes' => procs([['A', 0, 6, 5, 'VM1'], ['B', 0, 6, 5, 'VM2']])]);
check('HV proportional favours larger share', by_pid($d, 'completion')['A'] < by_pid($d, 'completion')['B']);

$lottery = ['vms' => [$vm('VM1'), $vm('VM2')], 'vmScheduler' => 'LOTTERY', 'vmQuantum' => 1,
    'processes' => procs([['A', 0, 5, 5, 'VM1'], ['B', 0, 5, 5, 'VM2']])];
check('HV lottery is reproducible', $hv($lottery) == $hv($lottery));

$d = $hv(['vms' => [$vm('VM1'), $vm('VM2')], 'vmScheduler' => 'CREDIT', 'vmQuantum' => 3,
    'processes' => procs([['A', 0, 50, 5, 'VM1'], ['B', 0, 50, 5, 'VM2']])]);
check('HV credit completes', !isset($d['error']) && count($d['results']) === 2);

$d = $hv(['vms' => [$vm('VM1')], 'enableIOScheduling' => true, 'processes' => procs([['A', 0, 4, 5, 'VM1', 3]])]);
check('HV I/O blocks mid-burst', by_pid($d, 'completion') == ['A' => 7] && count($d['ioSchedule']) === 1 && $d['ioSchedule'][0]['startTime'] == 2);

$five = procs(array_map(fn($i) => ["P$i", 0, 2, 5, 'VM1'], range(1, 5)));
$d = $hv(['vms' => [$vm('VM1'), $vm('VM2')], 'enableMigration' => true, 'migrationPenalty' => 1, 'processes' => $five]);
check('HV migrates under imbalance', $d['totalMigrations'] >= 1 && in_array('VM2', array_column($d['results'], 'vm'), true));
check('HV migration segment is labelled from→to', in_array('VM1→VM2', array_column(array_filter($d['segments'], fn($x) => $x['pid'] === 'MIGRATION'), 'vm'), true));
check('HV migration completes all', count($d['results']) === 5 && min(by_pid($d, 'completion')) > 0);

$d = $hv(['vms' => [$vm('VM1')], 'enableCaching' => true, 'vmQuantum' => 1, 'processQuantum' => 1,
    'processes' => procs([['A', 0, 3, 5, 'VM1'], ['B', 0, 3, 5, 'VM1']])]);
check('HV cache stats', $d['cacheStats']['hits'] + $d['cacheStats']['misses'] === 6);

$d = $hv(['vms' => [$vm('VM1', ['memory' => 128])], 'enableOvercommit' => true,
    'processes' => array_map(fn($p) => $p + ['memReq' => 512], procs([['A', 0, 2, 5, 'VM1']]))]);
check('HV overcommit adds paging penalty', $d['vmStats'][0]['overcommitEvents'] === 1 && by_pid($d, 'completion') == ['A' => 3]);

$d = $hv(['vms' => [$vm('VM1')], 'processes' => procs([['A', 0, 2, 5, 'VM1'], ['H', 0, 2]])]);
check('HV includes Host processes', by_pid($d, 'vm') == ['A' => 'VM1', 'H' => 'Host']);

check('HV rejects unknown VM', isset($hv(['vms' => [$vm('VM1')], 'processes' => procs([['A', 0, 2, 5, 'Ghost']])])['error']));
check('HV rejects duplicate VM', isset($hv(['vms' => [$vm('VM1'), $vm('VM1')], 'processes' => $abc])['error']));
check('HV rejects zero quantum', isset($hv(['vms' => [], 'processQuantum' => 0, 'processes' => $abc])['error']));


// --- Preemptive priority, aging, MLFQ boost and arrival preemption (simulate.php) ---
$d = call('simulate.php', ['algorithm' => 'PRIORITYP', 'processes' => procs([['A', 0, 5, 3], ['B', 1, 2, 1]])]);
check('Priority (P) preempts on arrival', by_pid($d, 'completion') == ['A' => 7, 'B' => 3]);
$d = call('simulate.php', ['algorithm' => 'PRIORITY', 'processes' => procs([['A', 0, 5, 3], ['B', 1, 2, 1]])]);
check('Priority (NP) does not preempt', by_pid($d, 'completion') == ['A' => 5, 'B' => 7]);

$aged = procs([['A', 0, 3, 5], ['B', 1, 3, 3], ['C', 2, 3, 2]]);
$d = call('simulate.php', ['algorithm' => 'PRIORITY', 'processes' => $aged, 'csOverhead' => 0]);
check('Priority without aging picks the best number', by_pid($d, 'completion') == ['A' => 3, 'B' => 9, 'C' => 6]);
$d = call('simulate.php', ['algorithm' => 'PRIORITY', 'processes' => $aged, 'aging' => 1, 'csOverhead' => 0]);
check('Priority aging lets a long waiter win a tie', by_pid($d, 'completion') == ['A' => 3, 'B' => 6, 'C' => 9]);

$xy = procs([['X', 0, 6, 2], ['Y', 0, 2, 3]]);
$d = call('simulate.php', ['algorithm' => 'PRIORITYP', 'processes' => $xy, 'csOverhead' => 0]);
check('Priority (P) without aging starves Y', by_pid($d, 'completion') == ['X' => 6, 'Y' => 8]);
$d = call('simulate.php', ['algorithm' => 'PRIORITYP', 'processes' => $xy, 'aging' => 1, 'csOverhead' => 0]);
check('Priority (P) aging lets Y through', by_pid($d, 'completion') == ['X' => 8, 'Y' => 6]);

$ab = procs([['A', 0, 6], ['B', 0, 6]]);
$d = call('simulate.php', ['algorithm' => 'MLFQ', 'quantum' => 1, 'processes' => $ab, 'csOverhead' => 0]);
check('MLFQ without boost', by_pid($d, 'completion') == ['A' => 9, 'B' => 12]);
$d = call('simulate.php', ['algorithm' => 'MLFQ', 'quantum' => 1, 'mlfqBoost' => 4, 'processes' => $ab, 'csOverhead' => 0]);
check('MLFQ boost returns jobs to the top level', by_pid($d, 'completion') == ['A' => 11, 'B' => 12]);

$late = procs([['A', 0, 20], ['B', 10, 3]]);
$d = call('simulate.php', ['algorithm' => 'MLFQ', 'quantum' => 2, 'processes' => $late, 'csOverhead' => 0]);
check('MLFQ lower level yields to a new arrival', by_pid($d, 'completion') == ['A' => 23, 'B' => 13] && by_pid($d, 'response')['B'] == 0);
$d = call('simulate.php', ['algorithm' => 'RR', 'quantum' => 8, 'processes' => $late, 'csOverhead' => 0]);
check('RR is not preempted by arrivals', by_pid($d, 'completion')['B'] == 19);

check('rejects bad aging', isset(call('simulate.php', ['algorithm' => 'PRIORITYP', 'aging' => -1, 'processes' => $abc])['error']));
check('rejects bad mlfqBoost', isset(call('simulate.php', ['algorithm' => 'MLFQ', 'mlfqBoost' => 'x', 'processes' => $abc])['error']));

// --- Hypervisor: MLFQ levels, boost, preemption, I/O device, NUMA ---
$one = ['vms' => [$vm('VM1')], 'vmQuantum' => 100];
$d = $hv($one + ['processAlgo' => 'MLFQ', 'processQuantum' => 1, 'processes' => procs([['A', 0, 6, 5, 'VM1'], ['B', 0, 6, 5, 'VM1']])]);
check('HV MLFQ demotes per process', by_pid($d, 'completion') == ['A' => 9, 'B' => 12]);
$d = $hv($one + ['processAlgo' => 'RR', 'processQuantum' => 1, 'processes' => procs([['A', 0, 6, 5, 'VM1'], ['B', 0, 6, 5, 'VM1']])]);
check('HV RR differs from MLFQ', by_pid($d, 'completion') == ['A' => 11, 'B' => 12]);
$d = $hv($one + ['processAlgo' => 'MLFQ', 'processQuantum' => 1, 'mlfqBoost' => 4, 'processes' => procs([['A', 0, 6, 5, 'VM1'], ['B', 0, 6, 5, 'VM1']])]);
check('HV MLFQ boost', by_pid($d, 'completion') == ['A' => 11, 'B' => 12]);
$d = $hv($one + ['processAlgo' => 'MLFQ', 'processQuantum' => 2, 'processes' => procs([['A', 0, 20, 5, 'VM1'], ['B', 10, 3, 5, 'VM1']])]);
check('HV MLFQ yields to a new arrival', by_pid($d, 'completion') == ['A' => 23, 'B' => 13]);
$d = $hv($one + ['processAlgo' => 'PRIORITYP', 'processes' => procs([['A', 0, 5, 3, 'VM1'], ['B', 1, 2, 1, 'VM1']])]);
check('HV Priority (P) preempts', by_pid($d, 'completion') == ['A' => 7, 'B' => 3]);

$io3 = procs([['A', 0, 2, 5, 'VM1', 4, [1]], ['B', 0, 2, 3, 'VM1', 1, [1]], ['C', 0, 2, 1, 'VM1', 1, [1]]]);
$d = $hv($one + ['enableIOScheduling' => true, 'processes' => $io3]);
check('HV I/O device serves by priority', array_column($d['ioSchedule'], 'pid') == ['A', 'C', 'B']
    && array_column($d['ioSchedule'], 'startTime') == [1, 5, 6]
    && array_column($d['ioSchedule'], 'requestTime') == [1, 3, 2]);
check('HV I/O completions', by_pid($d, 'completion') == ['A' => 6, 'C' => 7, 'B' => 8]);

$d = $hv($one + ['enableIOScheduling' => true, 'processes' => procs([['P', 0, 6, 5, 'VM1', 2, [2, 4]]])]);
check('HV multiple user-defined I/O points', by_pid($d, 'completion') == ['P' => 10] && count($d['ioSchedule']) === 2);
check('rejects ioAt past the burst', isset($hv($one + ['processes' => procs([['P', 0, 5, 5, 'VM1', 2, [5]]])])['error']));
check('rejects non-numeric ioAt', isset(call('simulate.php', ['algorithm' => 'FCFS', 'processes' => [['pid' => 'P', 'arrival' => 0, 'burst' => 4, 'ioAt' => 'a,b']]])['error']));

$numa = ['vms' => [$vm('VM1'), $vm('VM2')], 'vmScheduler' => 'RR', 'vmQuantum' => 2,
    'processes' => procs([['A', 0, 4, 5, 'VM1'], ['B', 0, 4, 5, 'VM2']])];
$d = $hv($numa);
check('HV without NUMA penalty', by_pid($d, 'completion') == ['A' => 6, 'B' => 8]);
$d = $hv($numa + ['enableNUMA' => true]);
check('HV NUMA penalty on cross-node switches', by_pid($d, 'completion') == ['A' => 10, 'B' => 14]
    && array_column($d['vmStats'], 'numaHops', 'vm') == ['VM1' => 1, 'VM2' => 2]
    && count(array_filter($d['segments'], fn($s) => $s['pid'] === 'NUMA')) === 3);
check('HV results no longer carry affinity', !array_key_exists('affinity', $d['results'][0]));

// --- Rate limiter ---
$rlDir = sys_get_temp_dir() . '/cpusim-test-' . bin2hex(random_bytes(4));
mkdir($rlDir);
$t0 = 1000;
$hits = [];
for ($i = 0; $i < 4; $i++) {
    $hits[] = rate_limit_allow($rlDir, '1.2.3.4', 3, 60, $t0 + $i);
}
check('rate limit allows up to the limit then blocks', $hits[0] === 0 && $hits[2] === 0 && $hits[3] === 57);
check('rate limit retry-after counts down', rate_limit_allow($rlDir, '1.2.3.4', 3, 60, $t0 + 30) === 30);
check('rate limit is per client', rate_limit_allow($rlDir, '5.6.7.8', 3, 60, $t0) === 0);
check('rate limit resets after the window', rate_limit_allow($rlDir, '1.2.3.4', 3, 60, $t0 + 60) === 0);
check('rate limit fails open if the directory is unusable', rate_limit_allow($rlDir . '/missing', 'x', 1, 60, $t0) === 0);
array_map('unlink', glob($rlDir . '/*') ?: []);
rmdir($rlDir);

echo $failures ? "\n$failures check(s) failed\n" : "\nAll checks passed\n";
exit($failures ? 1 : 0);
