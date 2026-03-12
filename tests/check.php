<?php
// Self-check for both endpoints. Run: php tests/check.php
// Expected values are hand-computed textbook schedules.

$root = dirname(__DIR__);
$failures = 0;

function call($endpoint, $payload)
{
    global $root;
    $proc = proc_open([PHP_BINARY, "$root/$endpoint"], [['pipe', 'r'], ['pipe', 'w'], ['pipe', 'w']], $pipes);
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

function check($name, $cond)
{
    global $failures;
    echo ($cond ? 'ok   ' : 'FAIL ') . $name . "\n";
    if (!$cond) {
        $failures++;
    }
}

function by_pid($data, $field)
{
    return array_column($data['results'], $field, 'pid');
}

function procs($rows)
{
    return array_map(fn($r) => ['pid' => $r[0], 'arrival' => $r[1], 'burst' => $r[2], 'priority' => $r[3] ?? 5, 'vm' => $r[4] ?? 'Host', 'ioTime' => $r[5] ?? 0], $rows);
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

echo $failures ? "\n$failures check(s) failed\n" : "\nAll checks passed\n";
exit($failures ? 1 : 0);
