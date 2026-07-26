// AOM Spike popup.

const out = document.getElementById("out");

function show(v) {
  out.textContent = typeof v === "string" ? v : JSON.stringify(v, null, 2);
}

function send(msg) {
  chrome.runtime.sendMessage(msg, (resp) => {
    if (chrome.runtime.lastError) {
      show("Error: " + chrome.runtime.lastError.message);
      return;
    }
    show(resp && resp.note ? resp.note : resp);
  });
}

document.getElementById("startA").onclick = () => send({ type: "SPIKE_START_A" });
document.getElementById("stopA").onclick = () => send({ type: "SPIKE_STOP_A" });
document.getElementById("runB").onclick = () => send({ type: "SPIKE_RUN_B" });
document.getElementById("runC").onclick = () => send({ type: "SPIKE_RUN_C" });
document.getElementById("idle").onclick = () => send({ type: "SPIKE_IDLE" });

const urlEl = document.getElementById("relayUrl");
const secretEl = document.getElementById("relaySecret");

chrome.storage.local.get("spikeRelayCfg").then(({ spikeRelayCfg }) => {
  if (spikeRelayCfg) {
    urlEl.value = spikeRelayCfg.url || "";
    secretEl.value = spikeRelayCfg.secret || "";
  }
});

function relayCfg() {
  return { url: urlEl.value.trim(), secret: secretEl.value.trim() };
}

document.getElementById("saveD").onclick = async () => {
  await chrome.storage.local.set({ spikeRelayCfg: relayCfg() });
  show("Relay config saved.");
};

document.getElementById("runD").onclick = () =>
  send({ type: "SPIKE_RUN_D", cfg: relayCfg(), wrongSecret: false });

document.getElementById("runDwrong").onclick = () =>
  send({ type: "SPIKE_RUN_D", cfg: relayCfg(), wrongSecret: true });

document.getElementById("dump").onclick = async () => {
  const { spikeLog = [] } = await chrome.storage.local.get("spikeLog");
  show(
    spikeLog
      .map((e) => `${e.ts}  ${e.tag}  ${JSON.stringify(e.data)}`)
      .join("\n") || "(log empty)"
  );
};

document.getElementById("clear").onclick = async () => {
  await chrome.storage.local.remove("spikeLog");
  show("Log cleared.");
};
