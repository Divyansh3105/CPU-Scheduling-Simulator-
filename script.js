let processes = [];
let virtualMachines = [];
let simulationResults = null;

// Auto-process generation
let autoProcessInterval = null;
let autoProcessCountdown = null;
let processCounter = 1;

// Configuration - Update these paths to match your server
const PHP_BACKEND = {
  simulate: "simulate.php",
  hypervisor: "simulate_hypervisor.php",
};

// Tab switching
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", function () {
    const tabName = this.getAttribute("data-tab");
    document
      .querySelectorAll(".tab")
      .forEach((t) => t.classList.remove("active"));
    document
      .querySelectorAll(".tab-content")
      .forEach((c) => c.classList.remove("active"));
    this.classList.add("active");
    document.getElementById(`${tabName}-tab`).classList.add("active");
  });
});

// Hypervisor mode toggle
document.getElementById("hypervisorMode").addEventListener("change", (e) => {
  document.getElementById("hypervisorSettings").style.display = e.target.checked
    ? "grid"
    : "none";
});

// Slider updates
document
  .getElementById("contextSwitchOverhead")
  .addEventListener("input", (e) => {
    document.getElementById("csOverheadValue").textContent = e.target.value;
  });

document.getElementById("migrationPenalty").addEventListener("input", (e) => {
  document.getElementById("migrationValue").textContent = e.target.value;
});

// Add VM
document.getElementById("vmForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const vmName = document.getElementById("vmName").value.trim();
  const vmPriority = parseInt(document.getElementById("vmPriority").value) || 5;
  const vmCPUShare =
    parseInt(document.getElementById("vmCPUShare").value) || 25;
  const vmMemory = parseInt(document.getElementById("vmMemory").value) || 512;
  const vmType = document.getElementById("vmType").value;

  if (!vmName) {
    showNotification("Please enter VM name!", "error");
    return;
  }

  if (virtualMachines.some((v) => v.name === vmName)) {
    showNotification("VM name already exists!", "error");
    return;
  }

  virtualMachines.push({
    name: vmName,
    priority: vmPriority,
    cpuShare: vmCPUShare,
    memory: vmMemory,
    type: vmType,
    status: "active",
  });

  updateVMTable();
  updateVMDropdown();
  updateVMCount();
  document.getElementById("vmForm").reset();
  showNotification(`VM "${vmName}" added successfully!`, "success");
});

// Add Process
document.getElementById("processForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const pid = document.getElementById("pid").value.trim();
  const arrival = parseInt(document.getElementById("arrival").value);
  const burst = parseInt(document.getElementById("burst").value);
  const priority = document.getElementById("priority").value
    ? parseInt(document.getElementById("priority").value)
    : 5;
  const ioTime = parseInt(document.getElementById("ioTime").value) || 0;
  const memReq = parseInt(document.getElementById("memReq").value) || 64;
  const vmAssignment = document.getElementById("vmAssignment").value;

  if (!pid || isNaN(arrival) || isNaN(burst)) {
    showNotification(
      "Please fill Process ID, Arrival Time and Burst Time!",
      "error"
    );
    return;
  }

  if (processes.some((p) => p.pid === pid)) {
    showNotification("Process ID already exists!", "error");
    return;
  }

  processes.push({
    pid,
    arrival,
    burst,
    priority,
    ioTime,
    memReq,
    vm: vmAssignment || "Host",
    originalBurst: burst,
  });

  updateProcessTable();
  updateProcessCount();
  document.getElementById("processForm").reset();
  showNotification(`Process "${pid}" added successfully!`, "success");
});

// Button handlers
document
  .getElementById("loadSampleVMsBtn")
  .addEventListener("click", loadSampleVMs);
document
  .getElementById("loadBalancedVMsBtn")
  .addEventListener("click", loadBalancedVMs);
document
  .getElementById("clearAllVMsBtn")
  .addEventListener("click", clearAllVMs);
document
  .getElementById("loadSampleProcessesBtn")
  .addEventListener("click", loadSampleProcesses);
document
  .getElementById("loadIOIntensiveBtn")
  .addEventListener("click", loadIOIntensiveProcesses);
document
  .getElementById("loadCPUIntensiveBtn")
  .addEventListener("click", loadCPUIntensiveProcesses);
document
  .getElementById("clearAllProcessesBtn")
  .addEventListener("click", clearAllProcesses);
document
  .getElementById("runSimulationBtn")
  .addEventListener("click", runSimulation);

// Auto-process generation
document.getElementById("autoProcessToggle").addEventListener("change", (e) => {
  if (e.target.checked) {
    if (virtualMachines.length === 0) {
      showNotification("Please add at least one VM first!", "error");
      e.target.checked = false;
      return;
    }
    startAutoProcessGeneration();
  } else {
    stopAutoProcessGeneration();
  }
});

function startAutoProcessGeneration() {
  document.getElementById("autoProcessStatus").style.display = "block";
  showNotification("Auto-process generation started!", "success");

  let countdown = 5;
  document.getElementById("countdown").textContent = countdown;

  autoProcessCountdown = setInterval(() => {
    countdown--;
    document.getElementById("countdown").textContent = countdown;
    if (countdown <= 0) countdown = 5;
  }, 1000);

  autoProcessInterval = setInterval(() => {
    generateRandomProcess();
  }, 5000);
}

function stopAutoProcessGeneration() {
  if (autoProcessInterval) {
    clearInterval(autoProcessInterval);
    autoProcessInterval = null;
  }
  if (autoProcessCountdown) {
    clearInterval(autoProcessCountdown);
    autoProcessCountdown = null;
  }
  document.getElementById("autoProcessStatus").style.display = "none";
  showNotification("Auto-process generation stopped!", "info");
}

function generateRandomProcess() {
  if (virtualMachines.length === 0) {
    stopAutoProcessGeneration();
    document.getElementById("autoProcessToggle").checked = false;
    showNotification("No VMs available. Auto-generation stopped.", "error");
    return;
  }

  const pid = `AUTO_P${processCounter++}`;
  const arrival =
    processes.length > 0
      ? Math.max(...processes.map((p) => p.arrival)) +
        Math.floor(Math.random() * 3) +
        1
      : 0;
  const burst = Math.floor(Math.random() * 10) + 3;
  const priority = Math.floor(Math.random() * 10) + 1;
  const ioTime = Math.random() > 0.5 ? Math.floor(Math.random() * 4) : 0;
  const memReq = [64, 128, 256, 512][Math.floor(Math.random() * 4)];
  const randomVM =
    virtualMachines[Math.floor(Math.random() * virtualMachines.length)];

  processes.push({
    pid,
    arrival,
    burst,
    priority,
    ioTime,
    memReq,
    vm: randomVM.name,
    originalBurst: burst,
  });

  updateProcessTable();
  updateProcessCount();
  showNotification(`🤖 Auto-generated: ${pid} → ${randomVM.name}`, "success");
}

function updateVMCount() {
  const countElement = document.getElementById("vmCount");
  if (countElement) {
    countElement.textContent = `${virtualMachines.length} VM${
      virtualMachines.length !== 1 ? "s" : ""
    }`;
  }
}

function updateProcessCount() {
  const countElement = document.getElementById("processCount");
  if (countElement) {
    countElement.textContent = `${processes.length} Process${
      processes.length !== 1 ? "es" : ""
    }`;
  }
}

function showNotification(message, type = "info") {
  const existingNotifications = document.querySelectorAll(".notification");
  existingNotifications.forEach((n) => n.remove());

  const notification = document.createElement("div");
  notification.className = `notification notification-${type}`;
  notification.textContent = message;

  const styles = {
    position: "fixed",
    top: "20px",
    right: "20px",
    padding: "16px 24px",
    borderRadius: "12px",
    fontWeight: "600",
    fontSize: "15px",
    zIndex: "10000",
    animation: "slideIn 0.3s ease-out",
    boxShadow: "0 8px 32px rgba(0, 0, 0, 0.4)",
    minWidth: "300px",
    maxWidth: "500px",
  };

  Object.assign(notification.style, styles);

  if (type === "success") {
    notification.style.background =
      "linear-gradient(135deg, #4caf50 0%, #66bb6a 100%)";
    notification.style.color = "#fff";
  } else if (type === "error") {
    notification.style.background =
      "linear-gradient(135deg, #ff4444 0%, #ff6666 100%)";
    notification.style.color = "#fff";
  } else {
    notification.style.background =
      "linear-gradient(135deg, #00ffcc 0%, #00d9b3 100%)";
    notification.style.color = "#000";
  }

  document.body.appendChild(notification);
  setTimeout(() => {
    notification.style.animation = "slideOut 0.3s ease-in";
    setTimeout(() => notification.remove(), 300);
  }, 3000);
}

if (!document.getElementById("notification-styles")) {
  const style = document.createElement("style");
  style.id = "notification-styles";
  style.textContent = `
    @keyframes slideIn {
      from { transform: translateX(400px); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }
    @keyframes slideOut {
      from { transform: translateX(0); opacity: 1; }
      to { transform: translateX(400px); opacity: 0; }
    }
  `;
  document.head.appendChild(style);
}

function updateVMTable() {
  const tbody = document.querySelector("#vmTable tbody");
  if (virtualMachines.length === 0) {
    tbody.innerHTML = `<tr class="empty-state"><td colspan="8"><div class="empty-content"><div class="empty-icon">🖥️</div><p>No virtual machines added yet</p><span>Add your first VM above to get started</span></div></td></tr>`;
    return;
  }

  tbody.innerHTML = "";
  virtualMachines.forEach((vm, idx) => {
    const vmProcessCount = processes.filter((p) => p.vm === vm.name).length;
    const statusClass =
      vm.status === "active" ? "status-active" : "status-idle";
    const row = document.createElement("tr");
    row.innerHTML = `
      <td><strong>${vm.name}</strong></td>
      <td><span class="vm-badge">${vm.type}</span></td>
      <td>${vm.priority}</td>
      <td>${vm.cpuShare}%</td>
      <td>${vm.memory} MB</td>
      <td><span class="process-badge">${vmProcessCount} processes</span></td>
      <td><span class="status-badge ${statusClass}">${vm.status}</span></td>
      <td><button class="remove-btn" data-idx="${idx}">✕ Remove</button></td>
    `;
    row.querySelector(".remove-btn").addEventListener("click", function () {
      removeVM(this.getAttribute("data-idx"));
    });
    tbody.appendChild(row);
  });
}

function updateVMDropdown() {
  const select = document.getElementById("vmAssignment");
  select.innerHTML = '<option value="">🏠 Host (No VM)</option>';
  virtualMachines.forEach((vm) => {
    const icon =
      vm.type === "compute"
        ? "⚡"
        : vm.type === "memory"
        ? "💾"
        : vm.type === "realtime"
        ? "⏱️"
        : "🔷";
    select.innerHTML += `<option value="${vm.name}">${icon} ${vm.name} (${vm.type})</option>`;
  });
}

function updateProcessTable() {
  const tbody = document.querySelector("#processTable tbody");
  if (processes.length === 0) {
    tbody.innerHTML = `<tr class="empty-state"><td colspan="8"><div class="empty-content"><div class="empty-icon">📋</div><p>No processes added yet</p><span>Add your first process above to get started</span></div></td></tr>`;
    return;
  }

  tbody.innerHTML = "";
  processes.forEach((p, idx) => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td><strong>${p.pid}</strong></td>
      <td>${p.arrival}</td>
      <td>${p.burst}</td>
      <td>${p.ioTime || 0}</td>
      <td>${
        p.priority !== null && p.priority !== undefined ? p.priority : "-"
      }</td>
      <td>${p.memReq || 64} MB</td>
      <td><span class="process-badge">${p.vm}</span></td>
      <td><button class="remove-btn" data-idx="${idx}">✕</button></td>
    `;
    row.querySelector(".remove-btn").addEventListener("click", function () {
      removeProcess(this.getAttribute("data-idx"));
    });
    tbody.appendChild(row);
  });
}

function removeVM(idx) {
  const vm = virtualMachines[idx];
  if (
    confirm(
      `Remove ${vm.name}? All processes assigned to this VM will be moved to Host.`
    )
  ) {
    processes.forEach((p) => {
      if (p.vm === vm.name) p.vm = "Host";
    });
    virtualMachines.splice(idx, 1);
    updateVMTable();
    updateVMDropdown();
    updateProcessTable();
    updateVMCount();
    showNotification(`VM "${vm.name}" removed successfully!`, "success");
    if (virtualMachines.length === 0 && autoProcessInterval) {
      stopAutoProcessGeneration();
      document.getElementById("autoProcessToggle").checked = false;
    }
  }
}

function removeProcess(idx) {
  const process = processes[idx];
  if (confirm(`Remove process ${process.pid}?`)) {
    processes.splice(idx, 1);
    updateProcessTable();
    updateProcessCount();
    showNotification(
      `Process "${process.pid}" removed successfully!`,
      "success"
    );
  }
}

function clearAllVMs() {
  if (virtualMachines.length === 0) return;
  if (confirm("Clear all virtual machines? Processes will be moved to Host.")) {
    processes.forEach((p) => (p.vm = "Host"));
    virtualMachines = [];
    updateVMTable();
    updateVMDropdown();
    updateProcessTable();
    updateVMCount();
    showNotification("All VMs cleared!", "success");
    if (autoProcessInterval) {
      stopAutoProcessGeneration();
      document.getElementById("autoProcessToggle").checked = false;
    }
  }
}

function clearAllProcesses() {
  if (processes.length === 0) return;
  if (confirm("Clear all processes?")) {
    processes = [];
    processCounter = 1;
    updateProcessTable();
    updateProcessCount();
    showNotification("All processes cleared!", "success");
  }
}

function loadSampleVMs() {
  virtualMachines = [
    {
      name: "VM1",
      priority: 2,
      cpuShare: 40,
      memory: 1024,
      type: "compute",
      status: "active",
    },
    {
      name: "VM2",
      priority: 5,
      cpuShare: 30,
      memory: 512,
      type: "standard",
      status: "active",
    },
    {
      name: "VM3",
      priority: 8,
      cpuShare: 30,
      memory: 2048,
      type: "memory",
      status: "active",
    },
  ];
  updateVMTable();
  updateVMDropdown();
  updateVMCount();
  showNotification("Sample VMs loaded!", "success");
}

function loadBalancedVMs() {
  virtualMachines = [
    {
      name: "Web-VM",
      priority: 3,
      cpuShare: 25,
      memory: 512,
      type: "standard",
      status: "active",
    },
    {
      name: "DB-VM",
      priority: 1,
      cpuShare: 35,
      memory: 2048,
      type: "memory",
      status: "active",
    },
    {
      name: "App-VM",
      priority: 2,
      cpuShare: 25,
      memory: 1024,
      type: "compute",
      status: "active",
    },
    {
      name: "Cache-VM",
      priority: 4,
      cpuShare: 15,
      memory: 512,
      type: "realtime",
      status: "active",
    },
  ];
  updateVMTable();
  updateVMDropdown();
  updateVMCount();
  showNotification("Balanced VM setup loaded!", "success");
}

function loadSampleProcesses() {
  processes = [
    {
      pid: "P1",
      arrival: 0,
      burst: 5,
      priority: 2,
      ioTime: 1,
      memReq: 128,
      vm: "Host",
      originalBurst: 5,
    },
    {
      pid: "P2",
      arrival: 1,
      burst: 3,
      priority: 1,
      ioTime: 0,
      memReq: 64,
      vm: "Host",
      originalBurst: 3,
    },
    {
      pid: "P3",
      arrival: 2,
      burst: 8,
      priority: 3,
      ioTime: 2,
      memReq: 256,
      vm: "Host",
      originalBurst: 8,
    },
    {
      pid: "P4",
      arrival: 3,
      burst: 6,
      priority: 2,
      ioTime: 1,
      memReq: 128,
      vm: "Host",
      originalBurst: 6,
    },
  ];
  updateProcessTable();
  updateProcessCount();
  showNotification("Sample processes loaded!", "success");
}

function loadIOIntensiveProcesses() {
  processes = [
    {
      pid: "IO1",
      arrival: 0,
      burst: 4,
      priority: 3,
      ioTime: 3,
      memReq: 64,
      vm: "Host",
      originalBurst: 4,
    },
    {
      pid: "IO2",
      arrival: 1,
      burst: 3,
      priority: 4,
      ioTime: 4,
      memReq: 128,
      vm: "Host",
      originalBurst: 3,
    },
    {
      pid: "IO3",
      arrival: 2,
      burst: 5,
      priority: 3,
      ioTime: 3,
      memReq: 64,
      vm: "Host",
      originalBurst: 5,
    },
    {
      pid: "IO4",
      arrival: 3,
      burst: 2,
      priority: 5,
      ioTime: 5,
      memReq: 128,
      vm: "Host",
      originalBurst: 2,
    },
  ];
  updateProcessTable();
  updateProcessCount();
  showNotification("I/O intensive processes loaded!", "success");
}

function loadCPUIntensiveProcesses() {
  processes = [
    {
      pid: "CPU1",
      arrival: 0,
      burst: 10,
      priority: 1,
      ioTime: 0,
      memReq: 512,
      vm: "Host",
      originalBurst: 10,
    },
    {
      pid: "CPU2",
      arrival: 1,
      burst: 15,
      priority: 2,
      ioTime: 1,
      memReq: 256,
      vm: "Host",
      originalBurst: 15,
    },
    {
      pid: "CPU3",
      arrival: 2,
      burst: 12,
      priority: 1,
      ioTime: 0,
      memReq: 1024,
      vm: "Host",
      originalBurst: 12,
    },
    {
      pid: "CPU4",
      arrival: 3,
      burst: 8,
      priority: 3,
      ioTime: 1,
      memReq: 256,
      vm: "Host",
      originalBurst: 8,
    },
  ];
  updateProcessTable();
  updateProcessCount();
  showNotification("CPU intensive processes loaded!", "success");
}

async function runSimulation() {
  const algo = document.getElementById("algorithm").value;
  const quantum = parseInt(document.getElementById("quantum").value) || 2;
  const hypervisorMode = document.getElementById("hypervisorMode").checked;

  if (!algo) {
    showNotification("Please select a scheduling algorithm!", "error");
    return;
  }
  if (processes.length === 0) {
    showNotification("Please add at least one process!", "error");
    return;
  }
  if ((algo === "RR" || algo === "MLFQ") && quantum <= 0) {
    showNotification("Please enter a valid time quantum!", "error");
    return;
  }

  document.getElementById("results").style.display = "block";
  showNotification("Running simulation...", "info");

  try {
    if (hypervisorMode && virtualMachines.length > 0) {
      await simulateHypervisor();
    } else {
      await simulateNormal();
    }
    showNotification("Simulation completed successfully!", "success");
  } catch (error) {
    console.error("Simulation error:", error);
    showNotification("Simulation failed: " + error.message, "error");
  }
}

async function simulateNormal() {
  const algo = document.getElementById("algorithm").value;
  const quantum = parseInt(document.getElementById("quantum").value) || 2;
  const csOverhead =
    parseFloat(document.getElementById("contextSwitchOverhead").value) || 0;

  const payload = {
    algorithm: algo,
    quantum: quantum,
    processes: processes,
    csOverhead: csOverhead,
  };

  try {
    const response = await fetch(PHP_BACKEND.simulate, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const data = await response.json();
    if (data.error) throw new Error(data.error);

    simulationResults = data;
    renderResults(data);
    updateResourceMonitor(data);
  } catch (error) {
    console.error("Backend error:", error);
    throw new Error(
      "Failed to connect to PHP backend. Make sure simulate.php is accessible."
    );
  }
}

async function simulateHypervisor() {
  const algo = document.getElementById("algorithm").value;
  const quantum = parseInt(document.getElementById("quantum").value) || 2;
  const vmScheduler = document.getElementById("vmScheduler").value;
  const vmQuantum = parseInt(document.getElementById("vmQuantum").value) || 10;
  const enableMigration = document.getElementById("enableMigration").checked;
  const enableOvercommit = document.getElementById("enableOvercommit").checked;
  const enableIOScheduling =
    document.getElementById("enableIOScheduling").checked;
  const enableCaching = document.getElementById("enableCaching").checked;
  const csOverhead =
    parseFloat(document.getElementById("contextSwitchOverhead").value) || 0;
  const migrationPenalty =
    parseInt(document.getElementById("migrationPenalty").value) || 5;

  const payload = {
    processAlgo: algo,
    processQuantum: quantum,
    processes: processes,
    vms: virtualMachines,
    vmScheduler: vmScheduler,
    vmQuantum: vmQuantum,
    enableMigration: enableMigration,
    enableOvercommit: enableOvercommit,
    enableIOScheduling: enableIOScheduling,
    enableCaching: enableCaching,
    csOverhead: csOverhead,
    migrationPenalty: migrationPenalty,
  };

  try {
    const response = await fetch(PHP_BACKEND.hypervisor, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const data = await response.json();
    if (data.error) throw new Error(data.error);

    simulationResults = data;
    renderEnhancedResults(data);
    updateResourceMonitor(data);
  } catch (error) {
    console.error("Backend error:", error);
    throw new Error(
      "Failed to connect to PHP backend. Make sure simulate_hypervisor.php is accessible."
    );
  }
}

function renderResults(data) {
  renderTable(data.results);
  renderAverages(data.results, data.contextSwitches, data.totalMigrations);
  renderGantt(data.segments);
  renderLegend(data.segments);
  if (data.vmStats) renderVMStats(data.vmStats);
}

function renderTable(data) {
  const tbody = document.querySelector("#resultTable tbody");
  tbody.innerHTML = "";
  data.forEach((p) => {
    tbody.innerHTML += `<tr>
      <td><strong>${p.pid}</strong></td>
      <td><span class="process-badge">${p.vm}</span></td>
      <td>${p.arrival}</td><td>${p.burst}</td><td>${p.completion}</td>
      <td>${p.turnaround}</td><td>${p.waiting}</td><td>${p.response}</td>
      <td>${p.contextSwitches || 0}</td>
    </tr>`;
  });
}

function renderAverages(data, contextSwitches, migrations) {
  const avgTAT = data.reduce((sum, p) => sum + p.turnaround, 0) / data.length;
  const avgWT = data.reduce((sum, p) => sum + p.waiting, 0) / data.length;
  const avgRT = data.reduce((sum, p) => sum + p.response, 0) / data.length;
  const maxCompletion = Math.max(...data.map((p) => p.completion));
  const throughput = data.length / maxCompletion;
  const cpuUtilization =
    (data.reduce((sum, p) => sum + p.burst, 0) / maxCompletion) * 100;
  let migrationsText = migrations
    ? ` | 🔄 VM Migrations: <strong>${migrations}</strong>`
    : "";

  document.getElementById("averages").innerHTML = `
    📈 Average Turnaround Time: <strong>${avgTAT.toFixed(2)}</strong> |
    🕒 Average Waiting Time: <strong>${avgWT.toFixed(2)}</strong> |
    ⚡ Average Response Time: <strong>${avgRT.toFixed(2)}</strong><br>
    🎯 Throughput: <strong>${throughput.toFixed(2)} processes/unit</strong> |
    💻 CPU Utilization: <strong>${cpuUtilization.toFixed(2)}%</strong> |
    🔀 Context Switches: <strong>${
      contextSwitches || 0
    }</strong>${migrationsText}
  `;
}

function renderVMStats(vmStats) {
  const statsDiv = document.getElementById("vmStats");
  statsDiv.innerHTML = `
    <div class="section-header">
      <h3>🖥️ Virtual Machine Statistics</h3>
      <div class="section-badge">Per-VM Performance</div>
    </div>
    <div class='vm-stats-grid'>`;

  vmStats.forEach((stat) => {
    statsDiv.innerHTML += `
      <div class="vm-stat-card">
        <h4>${stat.vm}</h4>
        <div class="metric"><span>CPU Time:</span><strong>${
          stat.cpuTime
        } units</strong></div>
        <div class="metric"><span>Utilization:</span><strong>${stat.utilization.toFixed(
          2
        )}%</strong></div>
        <div class="metric"><span>Idle Time:</span><strong>${
          stat.idleTime
        } units</strong></div>
        <div class="metric"><span>Processes:</span><strong>${
          stat.processCount
        }</strong></div>
        <div class="metric"><span>Migrations:</span><strong>${
          stat.migrations || 0
        }</strong></div>
      </div>`;
  });
  statsDiv.innerHTML += "</div>";
}

function renderLegend(segments) {
  const legendDiv = document.getElementById("legend");
  const colors = {};
  const uniquePids = [...new Set(segments.map((s) => s.pid))].filter(
    (pid) => pid !== "IDLE" && pid !== "MIGRATION"
  );

  uniquePids.forEach((pid) => {
    colors[pid] = getColorForProcess(pid);
  });

  legendDiv.innerHTML = "<strong>Process Colors:</strong>";
  Object.entries(colors).forEach(([pid, color]) => {
    legendDiv.innerHTML += `<div class="legend-item"><div class="legend-color" style="background: ${color}"></div><span>${pid}</span></div>`;
  });

  legendDiv.innerHTML += `<div class="legend-item"><div class="legend-color" style="background: #333"></div><span>IDLE</span></div>`;

  if (segments.some((s) => s.pid === "MIGRATION")) {
    legendDiv.innerHTML += `<div class="legend-item"><div class="legend-color" style="background: #ff6464"></div><span>MIGRATION</span></div>`;
  }
}

function getColorForProcess(pid) {
  const hash = pid
    .split("")
    .reduce((acc, char) => char.charCodeAt(0) + ((acc << 5) - acc), 0);
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 70%, 60%)`;
}

function renderGantt(segments) {
  const canvas = document.getElementById("ganttChart");
  const ctx = canvas.getContext("2d");

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!segments || segments.length === 0) return;

  const endTime = Math.max(...segments.map((s) => s.end));
  canvas.width = canvas.parentElement.offsetWidth;
  canvas.height = 200;
  const scale = (canvas.width - 40) / endTime;

  const colors = {};
  segments.forEach((s) => {
    if (!colors[s.pid] && s.pid !== "IDLE" && s.pid !== "MIGRATION") {
      colors[s.pid] = getColorForProcess(s.pid);
    }
  });

  segments.forEach((s, idx) => {
    const x = 20 + s.start * scale;
    const width = (s.end - s.start) * scale;
    const y = 50;
    const height = 80;

    if (s.pid === "IDLE") {
      ctx.fillStyle = "#333";
    } else if (s.pid === "MIGRATION") {
      ctx.fillStyle = "#ff6464";
    } else {
      ctx.fillStyle = colors[s.pid];
    }
    ctx.fillRect(x, y, width, height);

    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, width, height);

    ctx.fillStyle = "#fff";
    ctx.font = "bold 14px Inter";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    if (width > 30) {
      if (s.pid === "MIGRATION") {
        ctx.fillText("🔄", x + width / 2, y + height / 2);
      } else {
        ctx.fillText(s.pid, x + width / 2, y + height / 2 - 8);

        if (s.vm && s.vm !== "Host") {
          ctx.font = "10px Inter";
          ctx.fillText(`[${s.vm}]`, x + width / 2, y + height / 2 + 10);
        }
      }
    }

    ctx.font = "11px Inter";
    ctx.textAlign = "center";
    ctx.fillStyle = "#00ffcc";
    if (idx === 0 || segments[idx - 1].end !== s.start) {
      ctx.fillText(s.start, x, y + height + 20);
    }
  });

  const lastSegment = segments[segments.length - 1];
  const finalX = 20 + lastSegment.end * scale;
  ctx.fillStyle = "#00ffcc";
  ctx.font = "11px Inter";
  ctx.textAlign = "center";
  ctx.fillText(lastSegment.end, finalX, 150);
}

function updateResourceMonitor(data) {
  const monitorDiv = document.getElementById("resourceMonitor");

  if (!data || !data.results) {
    monitorDiv.innerHTML = `
      <div class="monitor-placeholder">
        <div class="placeholder-icon">📊</div>
        <p>No simulation data available</p>
        <span>Run a simulation to see resource utilization</span>
      </div>`;
    return;
  }

  const maxCompletion = Math.max(...data.results.map((p) => p.completion));
  const totalBurst = data.results.reduce((sum, p) => sum + p.burst, 0);
  const cpuUtilization = (totalBurst / maxCompletion) * 100;

  monitorDiv.innerHTML = `
    <h4 style="color: #00ffcc; margin-bottom: 24px; font-size: 1.3em;">Overall System Utilization</h4>

    <div style="margin-bottom: 24px;">
      <label style="color: #aaa; font-weight: 600;">CPU Utilization: <strong style="color: #00ffcc;">${cpuUtilization.toFixed(
        2
      )}%</strong></label>
      <div class="resource-bar">
        <div class="resource-bar-fill" style="width: ${cpuUtilization}%">${cpuUtilization.toFixed(
    1
  )}%</div>
      </div>
    </div>

    <div style="margin-bottom: 24px;">
      <label style="color: #aaa; font-weight: 600;">Throughput: <strong style="color: #00ffcc;">${(
        data.results.length / maxCompletion
      ).toFixed(2)} proc/unit</strong></label>
      <div class="resource-bar">
        <div class="resource-bar-fill" style="width: ${Math.min(
          100,
          (data.results.length / maxCompletion) * 50
        )}%; background: linear-gradient(90deg, #6464ff, #8484ff)">
          ${(data.results.length / maxCompletion).toFixed(2)}
        </div>
      </div>
    </div>

    <div style="margin-bottom: 24px;">
      <label style="color: #aaa; font-weight: 600;">Average Response Time: <strong style="color: #00ffcc;">${(
        data.results.reduce((sum, p) => sum + p.response, 0) /
        data.results.length
      ).toFixed(2)} units</strong></label>
      <div class="resource-bar">
        <div class="resource-bar-fill" style="width: ${Math.min(
          100,
          (data.results.reduce((sum, p) => sum + p.response, 0) /
            data.results.length) *
            10
        )}%; background: linear-gradient(90deg, #ff6464, #ff8484)">
          ${(
            data.results.reduce((sum, p) => sum + p.response, 0) /
            data.results.length
          ).toFixed(2)}
        </div>
      </div>
    </div>
  `;

  if (data.vmStats && data.vmStats.length > 0) {
    monitorDiv.innerHTML +=
      '<h4 style="color: #00ffcc; margin: 35px 0 24px 0; font-size: 1.3em;">Per-VM Utilization</h4>';

    data.vmStats.forEach((vm) => {
      monitorDiv.innerHTML += `
        <div style="margin-bottom: 24px;">
          <label style="color: #aaa; font-weight: 600;">${
            vm.vm
          }: <strong style="color: #00ffcc;">${vm.utilization.toFixed(
        2
      )}%</strong> (${vm.processCount} processes)</label>
          <div class="resource-bar">
            <div class="resource-bar-fill" style="width: ${
              vm.utilization
            }%">${vm.utilization.toFixed(1)}%</div>
          </div>
        </div>
      `;
    });
  }

  const avgTAT =
    data.results.reduce((sum, p) => sum + p.turnaround, 0) /
    data.results.length;
  const avgWT =
    data.results.reduce((sum, p) => sum + p.waiting, 0) / data.results.length;

  monitorDiv.innerHTML += `
    <h4 style="color: #00ffcc; margin: 35px 0 24px 0; font-size: 1.3em;">Performance Metrics</h4>
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 20px;">
      <div style="background: linear-gradient(135deg, rgba(0, 255, 204, 0.15) 0%, rgba(0, 255, 204, 0.05) 100%); padding: 20px; border-radius: 12px; border-left: 4px solid #00ffcc; box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);">
        <div style="color: #aaa; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">Avg Turnaround</div>
        <div style="color: #00ffcc; font-size: 28px; font-weight: 900;">${avgTAT.toFixed(
          2
        )}</div>
      </div>
      <div style="background: linear-gradient(135deg, rgba(100, 100, 255, 0.15) 0%, rgba(100, 100, 255, 0.05) 100%); padding: 20px; border-radius: 12px; border-left: 4px solid #6464ff; box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);">
        <div style="color: #aaa; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">Avg Waiting</div>
        <div style="color: #6464ff; font-size: 28px; font-weight: 900;">${avgWT.toFixed(
          2
        )}</div>
      </div>
      <div style="background: linear-gradient(135deg, rgba(255, 100, 100, 0.15) 0%, rgba(255, 100, 100, 0.05) 100%); padding: 20px; border-radius: 12px; border-left: 4px solid #ff6464; box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);">
        <div style="color: #aaa; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">Context Switches</div>
        <div style="color: #ff6464; font-size: 28px; font-weight: 900;">${
          data.contextSwitches || 0
        }</div>
      </div>
      ${
        data.totalMigrations
          ? `
      <div style="background: linear-gradient(135deg, rgba(255, 153, 68, 0.15) 0%, rgba(255, 153, 68, 0.05) 100%); padding: 20px; border-radius: 12px; border-left: 4px solid #ff9944; box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);">
        <div style="color: #aaa; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">VM Migrations</div>
        <div style="color: #ff9944; font-size: 28px; font-weight: 900;">${data.totalMigrations}</div>
      </div>
      `
          : ""
      }
    </div>
  `;
}

function renderEnhancedResults(data) {
  // Clear previous enhanced content
  const resultsDiv = document.getElementById("results");
  const existingSections = resultsDiv.querySelectorAll(
    ".migration-section, .cache-section, .io-section, .features-section"
  );
  existingSections.forEach((section) => section.remove());

  renderTable(data.results);
  renderAverages(data.results, data.contextSwitches, data.totalMigrations);
  renderGantt(data.segments);
  renderLegend(data.segments);

  if (data.vmStats) {
    renderEnhancedVMStats(data.vmStats);
  }

  if (data.hypervisorFeatures) {
    renderHypervisorFeatures(data.hypervisorFeatures);
  }

  if (data.migrations && data.migrations.length > 0) {
    renderMigrationTimeline(data.migrations);
  }

  if (data.cacheStats) {
    renderCacheStatistics(data.cacheStats);
  }

  if (data.ioSchedule && data.ioSchedule.length > 0) {
    renderIOSchedule(data.ioSchedule);
  }
}

function renderEnhancedVMStats(vmStats) {
  const statsDiv = document.getElementById("vmStats");
  statsDiv.innerHTML = `
    <div class="section-header">
      <h3>🖥️ Virtual Machine Statistics</h3>
      <div class="section-badge">Enhanced Hypervisor Metrics</div>
    </div>
    <div class='vm-stats-grid'>`;

  vmStats.forEach((stat) => {
    const overcommitBadge =
      stat.overcommitEvents && stat.overcommitEvents > 0
        ? `<div class="metric warning-metric">
           <span>⚠️ Overcommit Events:</span>
           <strong>${stat.overcommitEvents}</strong>
         </div>`
        : "";

    const cacheBadge =
      stat.cacheHits &&
      stat.cacheMisses &&
      stat.cacheHits + stat.cacheMisses > 0
        ? `<div class="metric cache-metric">
           <span>💾 Cache Hit Rate:</span>
           <strong>${(
             (stat.cacheHits / (stat.cacheHits + stat.cacheMisses)) *
             100
           ).toFixed(1)}%</strong>
         </div>`
        : "";

    const numaInfo =
      stat.numaNode !== undefined
        ? `<div class="metric">
           <span>🔢 NUMA Node:</span>
           <strong>Node ${stat.numaNode}</strong>
         </div>`
        : "";

    statsDiv.innerHTML += `
      <div class="vm-stat-card enhanced">
        <h4>${stat.vm}</h4>
        <div class="metric">
          <span>CPU Time:</span>
          <strong>${stat.cpuTime} units</strong>
        </div>
        <div class="metric">
          <span>Utilization:</span>
          <strong class="${
            stat.utilization > 80 ? "high-util" : ""
          }">${stat.utilization.toFixed(2)}%</strong>
        </div>
        <div class="metric">
          <span>Idle Time:</span>
          <strong>${stat.idleTime} units</strong>
        </div>
        <div class="metric">
          <span>Processes:</span>
          <strong>${stat.processCount}</strong>
        </div>
        <div class="metric">
          <span>Migrations:</span>
          <strong>${stat.migrations || 0}</strong>
        </div>
        ${numaInfo}
        ${overcommitBadge}
        ${cacheBadge}
      </div>`;
  });

  statsDiv.innerHTML += "</div>";
}

function renderMigrationTimeline(migrations) {
  const resultsDiv = document.getElementById("results");

  const migrationSection = document.createElement("div");
  migrationSection.className = "migration-section";
  migrationSection.innerHTML = `
    <div class="section-header">
      <h3>🔄 Process Migration Timeline</h3>
      <div class="section-badge">${migrations.length} Migrations</div>
    </div>
    <div class="migration-timeline">
      ${migrations
        .map(
          (m) => `
        <div class="migration-event">
          <div class="migration-icon">🔄</div>
          <div class="migration-details">
            <strong>${m.process}</strong>
            <span class="migration-path">${m.fromVM} → ${m.toVM}</span>
            <span class="migration-time">Time: ${m.time} (Penalty: ${m.penalty})</span>
          </div>
        </div>
      `
        )
        .join("")}
    </div>
  `;

  resultsDiv.appendChild(migrationSection);
}

function renderCacheStatistics(cacheStats) {
  const resultsDiv = document.getElementById("results");

  const cacheSection = document.createElement("div");
  cacheSection.className = "cache-section";
  cacheSection.innerHTML = `
    <div class="section-header">
      <h3>💾 CPU Cache Statistics</h3>
      <div class="section-badge">Cache Performance</div>
    </div>
    <div class="cache-stats">
      <div class="cache-stat-card">
        <div class="cache-stat-icon">✅</div>
        <div class="cache-stat-value">${cacheStats.hits}</div>
        <div class="cache-stat-label">Cache Hits</div>
      </div>
      <div class="cache-stat-card">
        <div class="cache-stat-icon">❌</div>
        <div class="cache-stat-value">${cacheStats.misses}</div>
        <div class="cache-stat-label">Cache Misses</div>
      </div>
      <div class="cache-stat-card highlight">
        <div class="cache-stat-icon">📊</div>
        <div class="cache-stat-value">${cacheStats.hitRate.toFixed(2)}%</div>
        <div class="cache-stat-label">Hit Rate</div>
      </div>
    </div>
    <div class="cache-explanation">
      ${
        cacheStats.hitRate > 70
          ? "🎯 Excellent cache performance! Low context switching overhead."
          : cacheStats.hitRate > 40
          ? "⚠️ Moderate cache performance. Consider optimizing process scheduling."
          : "❌ Poor cache performance. High thrashing detected."
      }
    </div>
  `;

  resultsDiv.appendChild(cacheSection);
}

function renderIOSchedule(ioSchedule) {
  const resultsDiv = document.getElementById("results");

  const ioSection = document.createElement("div");
  ioSection.className = "io-section";
  ioSection.innerHTML = `
    <div class="section-header">
      <h3>💿 I/O Operation Schedule</h3>
      <div class="section-badge">${ioSchedule.length} Operations</div>
    </div>
    <div class="table-wrapper">
      <table class="io-table">
        <thead>
          <tr>
            <th>Process</th>
            <th>VM</th>
            <th>I/O Time</th>
            <th>Priority</th>
            <th>Start Time</th>
          </tr>
        </thead>
        <tbody>
          ${ioSchedule
            .map(
              (io) => `
            <tr>
              <td><strong>${io.pid}</strong></td>
              <td><span class="process-badge">${io.vm}</span></td>
              <td>${io.ioTime} units</td>
              <td><span class="priority-badge priority-${io.priority}">${io.priority}</span></td>
              <td>${io.startTime}</td>
            </tr>
          `
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;

  resultsDiv.appendChild(ioSection);
}

function renderHypervisorFeatures(features) {
  const resultsDiv = document.getElementById("results");

  const featuresSection = document.createElement("div");
  featuresSection.className = "features-section";
  featuresSection.innerHTML = `
    <div class="section-header">
      <h3>⚙️ Active Hypervisor Features</h3>
    </div>
    <div class="features-grid">
      <div class="feature-card ${features.migration ? "enabled" : "disabled"}">
        <div class="feature-icon">🔄</div>
        <div class="feature-name">Live Migration</div>
        <div class="feature-status">${
          features.migration ? "Enabled" : "Disabled"
        }</div>
      </div>
      <div class="feature-card ${features.overcommit ? "enabled" : "disabled"}">
        <div class="feature-icon">📈</div>
        <div class="feature-name">Overcommitment</div>
        <div class="feature-status">${
          features.overcommit ? "Enabled" : "Disabled"
        }</div>
      </div>
      <div class="feature-card ${
        features.ioScheduling ? "enabled" : "disabled"
      }">
        <div class="feature-icon">💿</div>
        <div class="feature-name">I/O Scheduling</div>
        <div class="feature-status">${
          features.ioScheduling ? "Enabled" : "Disabled"
        }</div>
      </div>
      <div class="feature-card ${features.caching ? "enabled" : "disabled"}">
        <div class="feature-icon">💾</div>
        <div class="feature-name">CPU Caching</div>
        <div class="feature-status">${
          features.caching ? "Enabled" : "Disabled"
        }</div>
      </div>
    </div>
  `;

  resultsDiv.appendChild(featuresSection);
}

// Add CSS for new visualizations
const enhancedStyles = `
  .migration-section, .cache-section, .io-section, .features-section {
    margin-top: 40px;
  }

  .migration-timeline {
    display: flex;
    flex-direction: column;
    gap: 15px;
    margin-top: 20px;
  }

  .migration-event {
    display: flex;
    align-items: center;
    gap: 20px;
    background: linear-gradient(135deg, rgba(255, 153, 68, 0.1) 0%, rgba(255, 153, 68, 0.05) 100%);
    padding: 20px;
    border-radius: 12px;
    border-left: 4px solid #ff9944;
  }

  .migration-icon {
    font-size: 2em;
    animation: rotate 2s linear infinite;
  }

  .migration-details {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .migration-path {
    color: var(--text-muted);
    font-weight: 600;
  }

  .migration-time {
    color: var(--primary);
    font-size: 0.9em;
  }

  .cache-stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 20px;
    margin: 20px 0;
  }

  .cache-stat-card {
    background: var(--bg-input);
    padding: 30px;
    border-radius: 12px;
    text-align: center;
    border: 2px solid var(--border);
    transition: all 0.3s;
  }

  .cache-stat-card.highlight {
    border-color: var(--primary);
    background: linear-gradient(135deg, rgba(0, 255, 204, 0.1) 0%, rgba(0, 255, 204, 0.05) 100%);
  }

  .cache-stat-card:hover {
    transform: translateY(-5px);
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
  }

  .cache-stat-icon {
    font-size: 3em;
    margin-bottom: 10px;
  }

  .cache-stat-value {
    font-size: 2.5em;
    font-weight: 900;
    color: var(--primary);
    margin: 10px 0;
  }

  .cache-stat-label {
    color: var(--text-muted);
    font-size: 0.9em;
    text-transform: uppercase;
    letter-spacing: 1px;
  }

  .cache-explanation {
    background: var(--bg-input);
    padding: 20px;
    border-radius: 12px;
    text-align: center;
    font-weight: 600;
    font-size: 1.1em;
    margin-top: 20px;
  }

  .features-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 20px;
    margin-top: 20px;
  }

  .feature-card {
    background: var(--bg-input);
    padding: 30px;
    border-radius: 12px;
    text-align: center;
    border: 2px solid var(--border);
    transition: all 0.3s;
  }

  .feature-card.enabled {
    border-color: var(--success);
    background: linear-gradient(135deg, rgba(76, 175, 80, 0.15) 0%, rgba(76, 175, 80, 0.05) 100%);
  }

  .feature-card.disabled {
    opacity: 0.5;
  }

  .feature-icon {
    font-size: 3em;
    margin-bottom: 15px;
  }

  .feature-name {
    font-weight: 700;
    font-size: 1.1em;
    margin-bottom: 10px;
    color: var(--text);
  }

  .feature-status {
    color: var(--text-muted);
    font-size: 0.9em;
    text-transform: uppercase;
    letter-spacing: 1px;
  }

  .feature-card.enabled .feature-status {
    color: var(--success);
  }

  .vm-stat-card.enhanced {
    position: relative;
    overflow: visible;
  }

  .vm-stat-card.enhanced::after {
    content: '⚡';
    position: absolute;
    top: -10px;
    right: -10px;
    background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
    width: 40px;
    height: 40px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1.2em;
    box-shadow: 0 4px 15px rgba(0, 255, 204, 0.4);
  }

  .high-util {
    color: var(--danger) !important;
    animation: pulse 2s infinite;
  }

  .warning-metric {
    background: rgba(255, 193, 7, 0.1);
    border-radius: 8px;
    padding: 8px;
  }

  .cache-metric {
    background: rgba(0, 255, 204, 0.1);
    border-radius: 8px;
    padding: 8px;
  }

  .priority-badge {
    display: inline-block;
    padding: 4px 12px;
    border-radius: 12px;
    font-weight: 700;
    font-size: 0.85em;
  }

  .priority-1, .priority-2 { background: #4caf50; color: white; }
  .priority-3, .priority-4 { background: #ff9800; color: white; }
  .priority-5 { background: #ffc107; color: black; }
  .priority-6, .priority-7 { background: #ff5722; color: white; }
  .priority-8, .priority-9, .priority-10 { background: #f44336; color: white; }

  @keyframes rotate {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
`;

// Add the enhanced styles to the document
if (!document.getElementById("enhanced-styles")) {
  const styleElement = document.createElement("style");
  styleElement.id = "enhanced-styles";
  styleElement.textContent = enhancedStyles;
  document.head.appendChild(styleElement);
}

// Initialize on page load
document.addEventListener("DOMContentLoaded", function () {
  updateVMTable();
  updateProcessTable();
  updateVMDropdown();
  updateVMCount();
  updateProcessCount();
});
