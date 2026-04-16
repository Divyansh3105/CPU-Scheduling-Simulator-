import { simulate } from "./engine/simulate.js";
import { simulateHypervisor } from "./engine/hypervisor.js";

// The JavaScript engine runs in the browser (works on static hosting). Add ?backend=php to the URL
// to use the PHP endpoints instead; tests/parity.mjs keeps the two identical.
const usePhp = new URLSearchParams(location.search).get("backend") === "php";

const PHP_BACKEND = {
  simulate: "api/simulate.php",
  hypervisor: "api/simulate_hypervisor.php",
};

async function postPhp(url, payload) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error(`Can't reach ${url}. Start PHP (php -S localhost:8000 -t public) or drop ?backend=php.`);
  }
  const data = await response.json().catch(() => ({}));
  if (data.error) throw new Error(data.error);
  if (!response.ok) throw new Error(`The server answered ${response.status}.`);
  return data;
}

export async function runSchedule(hv, payload) {
  if (usePhp) return postPhp(hv ? PHP_BACKEND.hypervisor : PHP_BACKEND.simulate, payload);
  return hv ? simulateHypervisor(payload) : simulate(payload); // throws Error with the PHP messages
}
