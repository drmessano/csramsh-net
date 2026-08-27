/* Meshtastic Channel Encoder/Decoder
 * Uses the real Meshtastic ChannelSet / LoRaConfig protobuf messages so that
 * real device QR codes (https://meshtastic.org/e/#...) decode and re-encode
 * correctly. See meshtastic/protobufs: apponly.proto, channel.proto, config.proto.
 */

const PROTO_DEF = `
syntax = "proto3";

enum ModemPreset {
  LONG_FAST = 0;
  LONG_SLOW = 1;
  VERY_LONG_SLOW = 2;
  MEDIUM_SLOW = 3;
  MEDIUM_FAST = 4;
  SHORT_SLOW = 5;
  SHORT_FAST = 6;
  LONG_MODERATE = 7;
  SHORT_TURBO = 8;
}

enum RegionCode {
  UNSET = 0;
  US = 1;
  EU_433 = 2;
  EU_868 = 3;
  CN = 4;
  JP = 5;
  ANZ = 6;
  KR = 7;
  TW = 8;
  RU = 9;
  IN = 10;
  NZ_865 = 11;
  TH = 12;
  LORA_24 = 13;
  UA_433 = 14;
  UA_868 = 15;
  MY_433 = 16;
  MY_919 = 17;
  SG_923 = 18;
}

message LoRaConfig {
  bool use_preset = 1;
  ModemPreset modem_preset = 2;
  uint32 bandwidth = 3;
  uint32 spread_factor = 4;
  uint32 coding_rate = 5;
  float frequency_offset = 6;
  RegionCode region = 7;
  uint32 hop_limit = 8;
  bool tx_enabled = 9;
  int32 tx_power = 10;
  uint32 channel_num = 11;
  bool override_duty_cycle = 12;
  bool sx126x_rx_boosted_gain = 13;
  float override_frequency = 14;
  bool pa_fan_disabled = 15;
}

message ChannelSettings {
  bytes psk = 2;
  string name = 3;
  fixed32 id = 4;
  bool uplink_enabled = 5;
  bool downlink_enabled = 6;
}

message ChannelSet {
  repeated ChannelSettings settings = 1;
  LoRaConfig lora_config = 2;
}
`;

// Bandwidth (kHz) / Spread Factor / Coding Rate per preset, matching
// Meshtastic firmware's RadioInterface::applyModemPreset() table.
const PRESETS = {
  0: { label: "LongFast", bandwidth: 250, spreadFactor: 11, codingRate: 5 },
  1: { label: "LongSlow", bandwidth: 125, spreadFactor: 12, codingRate: 8 },
  2: { label: "VeryLongSlow", bandwidth: 62.5, spreadFactor: 12, codingRate: 8 },
  3: { label: "MediumSlow", bandwidth: 250, spreadFactor: 10, codingRate: 5 },
  4: { label: "MediumFast", bandwidth: 250, spreadFactor: 9, codingRate: 5 },
  5: { label: "ShortSlow", bandwidth: 250, spreadFactor: 8, codingRate: 5 },
  6: { label: "ShortFast", bandwidth: 250, spreadFactor: 7, codingRate: 5 },
  7: { label: "LongModerate", bandwidth: 125, spreadFactor: 11, codingRate: 8 },
  8: { label: "ShortTurbo", bandwidth: 500, spreadFactor: 7, codingRate: 5 },
};

// Region is not exposed in the UI; every encoded config is hardcoded to US.
const REGION_US = 1;

let root = null;

function randomId() {
  return crypto.getRandomValues(new Uint32Array(1))[0] >>> 0;
}

function newChannel(name) {
  return { name: name || "", psk: new Uint8Array(0), uplink: false, downlink: false, id: randomId(), pskEditable: false, isPrimary: false };
}

// PSK is shown/edited as standard base64 (with padding), matching how the
// official Meshtastic apps display channel keys (e.g. the default key is "AQ==").
function bytesToPskBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function pskBase64ToBytes(str) {
  str = str.trim();
  if (str.length === 0) return new Uint8Array(0);
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64urlToBytes(b64url) {
  let b64 = b64url.trim().replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function extractFragment(input) {
  input = input.trim();
  const idx = input.indexOf("#");
  return idx >= 0 ? input.slice(idx + 1) : input;
}

// Fresh default state (before any decode): a single LongFast primary channel
// with the well-known "Default" PSK, and firmware-typical hidden LoRa fields.
const state = {
  lora: {
    usePreset: true,
    modemPreset: 0,
    bandwidth: PRESETS[0].bandwidth,
    spreadFactor: PRESETS[0].spreadFactor,
    codingRate: PRESETS[0].codingRate,
    frequencyOffset: 0,
    overrideFrequency: 0,
    hopLimit: 3,
    txEnabled: true,
    sx126xRxBoostedGain: true,
    overrideDutyCycle: false,
    paFanDisabled: false,
    txPower: 0,
    channelNum: 0,
  },
  // Variable-length: only channels actually defined live here (1-8 entries).
  // Which one is primary is tracked by isPrimary, not by array position — the
  // list order (and each row's #) never changes when you switch Primary; the
  // array is only reordered momentarily at encode time, since the Meshtastic
  // wire format itself has no role field and infers primary from position 0.
  channels: [
    { name: "LongFast", psk: new Uint8Array([1]), uplink: false, downlink: false, id: randomId(), pskEditable: false, isPrimary: true },
  ],
};

function renderLora() {
  const presetSel = document.getElementById("preset");
  presetSel.value = state.lora.usePreset ? String(state.lora.modemPreset) : "custom";
  document.getElementById("bandwidth").value = state.lora.bandwidth;
  document.getElementById("spreadFactor").value = state.lora.spreadFactor;
  document.getElementById("codingRate").value = state.lora.codingRate;
  document.getElementById("freqOffset").value = state.lora.frequencyOffset;
  document.getElementById("overrideFreq").value = state.lora.overrideFrequency;

  const locked = state.lora.usePreset;
  ["bandwidth", "spreadFactor", "codingRate"].forEach(id => {
    const el = document.getElementById(id);
    el.readOnly = locked;
    el.classList.toggle("locked", locked);
  });
}

function renderChannels() {
  const tbody = document.getElementById("channelRows");
  tbody.innerHTML = "";
  state.channels.forEach((ch, i) => {
    const tr = document.createElement("tr");

    const tdIdx = document.createElement("td");
    tdIdx.textContent = i + 1;

    const tdRole = document.createElement("td");
    if (state.channels.length > 1) {
      const sel = document.createElement("select");
      const optPrimary = document.createElement("option");
      optPrimary.value = "primary";
      optPrimary.textContent = "Primary";
      const optSecondary = document.createElement("option");
      optSecondary.value = "secondary";
      optSecondary.textContent = "Secondary";
      // Can't demote the current primary directly — pick a different row's
      // Primary instead, which demotes this one automatically.
      optSecondary.disabled = ch.isPrimary;
      sel.append(optPrimary, optSecondary);
      sel.value = ch.isPrimary ? "primary" : "secondary";
      sel.addEventListener("change", () => {
        if (sel.value === "primary") {
          state.channels.forEach(c => { c.isPrimary = false; });
          ch.isPrimary = true;
          renderChannels();
        }
      });
      tdRole.appendChild(sel);
    } else {
      tdRole.textContent = "Primary";
    }

    const tdName = document.createElement("td");
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "chan-name";
    // Meshtastic channel names must be under 12 bytes.
    nameInput.maxLength = 11;
    nameInput.value = ch.name;
    nameInput.addEventListener("input", () => { ch.name = nameInput.value; });
    tdName.appendChild(nameInput);

    const tdPskEdit = document.createElement("td");
    const cbPskEdit = document.createElement("input");
    cbPskEdit.type = "checkbox";
    cbPskEdit.title = "Enable to set a custom PSK";
    cbPskEdit.checked = !!ch.pskEditable;
    tdPskEdit.appendChild(cbPskEdit);

    const tdPskVal = document.createElement("td");
    const pskVal = document.createElement("input");
    pskVal.type = "text";
    pskVal.className = "psk-b64";
    pskVal.placeholder = "none";
    // Max PSK is 32 bytes (AES256), which is 44 base64 characters with padding.
    pskVal.maxLength = 44;
    pskVal.value = bytesToPskBase64(ch.psk);
    pskVal.disabled = !ch.pskEditable;
    tdPskVal.appendChild(pskVal);

    cbPskEdit.addEventListener("change", () => {
      ch.pskEditable = cbPskEdit.checked;
      renderChannels();
    });
    pskVal.addEventListener("input", () => {
      try {
        ch.psk = pskBase64ToBytes(pskVal.value);
        pskVal.classList.remove("input-error");
      } catch (e) {
        pskVal.classList.add("input-error");
      }
    });

    const tdUp = document.createElement("td");
    const cbUp = document.createElement("input");
    cbUp.type = "checkbox";
    cbUp.title = "Uplink: relay this channel's traffic to MQTT";
    cbUp.checked = !!ch.uplink;
    cbUp.addEventListener("change", () => { ch.uplink = cbUp.checked; });
    tdUp.appendChild(cbUp);

    const tdDown = document.createElement("td");
    const cbDown = document.createElement("input");
    cbDown.type = "checkbox";
    cbDown.title = "Downlink: relay MQTT traffic into this channel";
    cbDown.checked = !!ch.downlink;
    cbDown.addEventListener("change", () => { ch.downlink = cbDown.checked; });
    tdDown.appendChild(cbDown);

    const tdDel = document.createElement("td");
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "row-remove";
    removeBtn.textContent = "✕";
    removeBtn.title = "Remove this channel";
    removeBtn.addEventListener("click", () => {
      const wasPrimary = ch.isPrimary;
      state.channels.splice(i, 1);
      // Someone has to be primary if any channels remain — promote whichever
      // one is now first.
      if (wasPrimary && state.channels.length > 0) state.channels[0].isPrimary = true;
      renderChannels();
    });
    tdDel.appendChild(removeBtn);

    tr.append(tdIdx, tdRole, tdName, tdPskEdit, tdPskVal, tdUp, tdDown, tdDel);
    tbody.appendChild(tr);
  });

  document.getElementById("addChannelBtn").disabled = state.channels.length >= 8;
}

function setQrStatus(text, cls) {
  const el = document.getElementById("qrStatus");
  el.textContent = text;
  el.className = cls || "";
}

async function decodeConfig(rawInput) {
  const frag = extractFragment(rawInput);
  const bytes = base64urlToBytes(frag);
  const ChannelSet = root.lookupType("ChannelSet");
  const msg = ChannelSet.decode(bytes);
  return ChannelSet.toObject(msg, { defaults: true });
}

function loadStateFromDecoded(obj) {
  const lora = obj.loraConfig || {};
  state.lora.usePreset = !!lora.usePreset;
  state.lora.modemPreset = lora.modemPreset || 0;
  state.lora.frequencyOffset = lora.frequencyOffset || 0;
  state.lora.overrideFrequency = lora.overrideFrequency || 0;
  state.lora.hopLimit = lora.hopLimit || 0;
  state.lora.txEnabled = !!lora.txEnabled;
  state.lora.sx126xRxBoostedGain = !!lora.sx126xRxBoostedGain;
  state.lora.overrideDutyCycle = !!lora.overrideDutyCycle;
  state.lora.paFanDisabled = !!lora.paFanDisabled;
  state.lora.txPower = lora.txPower || 0;
  state.lora.channelNum = lora.channelNum || 0;

  if (state.lora.usePreset) {
    const p = PRESETS[state.lora.modemPreset] || PRESETS[0];
    state.lora.bandwidth = p.bandwidth;
    state.lora.spreadFactor = p.spreadFactor;
    state.lora.codingRate = p.codingRate;
  } else {
    state.lora.bandwidth = lora.bandwidth || 0;
    state.lora.spreadFactor = lora.spreadFactor || 0;
    state.lora.codingRate = lora.codingRate || 0;
  }

  const settings = obj.settings || [];
  state.channels = settings.slice(0, 8).map((s, i) => ({
    name: s.name || "",
    psk: s.psk instanceof Uint8Array ? s.psk : new Uint8Array(0),
    uplink: !!s.uplinkEnabled,
    downlink: !!s.downlinkEnabled,
    id: s.id || randomId(),
    pskEditable: false,
    isPrimary: i === 0,
  }));
  if (state.channels.length === 0) state.channels = [newChannel("")];
  if (!state.channels.some(c => c.isPrimary)) state.channels[0].isPrimary = true;
}

function buildChannelSet(clearHidden) {
  const ChannelSet = root.lookupType("ChannelSet");
  // The wire format has no role field — it infers primary from position 0 —
  // so the primary-flagged channel is moved to the front only here, at encode
  // time. The on-screen row order/# is unaffected by this.
  const primaryIdx = state.channels.findIndex(c => c.isPrimary);
  const ordered = primaryIdx > 0
    ? [state.channels[primaryIdx], ...state.channels.filter((_, idx) => idx !== primaryIdx)]
    : state.channels;
  const settings = ordered.map(ch => ({
    name: ch.name || "",
    psk: ch.psk || new Uint8Array(0),
    uplinkEnabled: !!ch.uplink,
    downlinkEnabled: !!ch.downlink,
    id: ch.id >>> 0,
  }));

  if (clearHidden) {
    while (settings.length < 8) {
      settings.push({ name: "", psk: new Uint8Array(0), uplinkEnabled: false, downlinkEnabled: false, id: 0 });
    }
  }

  const loraConfig = {
    usePreset: state.lora.usePreset,
    modemPreset: state.lora.modemPreset,
    bandwidth: state.lora.bandwidth,
    spreadFactor: state.lora.spreadFactor,
    codingRate: state.lora.codingRate,
    frequencyOffset: state.lora.frequencyOffset,
    region: REGION_US,
    overrideFrequency: state.lora.overrideFrequency,
    hopLimit: state.lora.hopLimit,
    txEnabled: state.lora.txEnabled,
    txPower: state.lora.txPower,
    channelNum: state.lora.channelNum,
    overrideDutyCycle: state.lora.overrideDutyCycle,
    sx126xRxBoostedGain: state.lora.sx126xRxBoostedGain,
    paFanDisabled: state.lora.paFanDisabled,
  };

  const payload = { settings, loraConfig };
  const ChannelSetType = ChannelSet;
  const errMsg = ChannelSetType.verify(payload);
  if (errMsg) throw new Error(errMsg);
  const msg = ChannelSetType.create(payload);
  return ChannelSetType.encode(msg).finish();
}

function jsonReplacer(key, value) {
  if (value instanceof Uint8Array) return `base64:${bytesToPskBase64(value)}`;
  return value;
}

function decodeAndLoad(raw) {
  const out = document.getElementById("decodeResult");
  if (!raw) {
    out.textContent = "Enter a URL/fragment or upload a QR image first.";
    return;
  }
  try {
    decodeConfig(raw).then(obj => {
      out.textContent = JSON.stringify(obj, jsonReplacer, 2);
      loadStateFromDecoded(obj);
      renderLora();
      renderChannels();
      setQrStatus("Decoded and loaded into the editor below.", "success");
    }).catch(err => {
      out.textContent = "Error: " + err.message;
      setQrStatus("Decode failed.", "fail");
    });
  } catch (err) {
    out.textContent = "Error: " + err.message;
    setQrStatus("Decode failed.", "fail");
  }
}

function init() {
  root = protobuf.parse(PROTO_DEF).root;

  renderLora();
  renderChannels();

  document.getElementById("preset").addEventListener("change", e => {
    const val = e.target.value;
    if (val === "custom") {
      state.lora.usePreset = false;
    } else {
      const p = PRESETS[Number(val)];
      state.lora.usePreset = true;
      state.lora.modemPreset = Number(val);
      state.lora.bandwidth = p.bandwidth;
      state.lora.spreadFactor = p.spreadFactor;
      state.lora.codingRate = p.codingRate;

      if (state.channels.length === 0) {
        const primary = newChannel(p.label);
        primary.psk = new Uint8Array([1]);
        primary.isPrimary = true;
        state.channels.push(primary);
      } else {
        const primary = state.channels.find(c => c.isPrimary) || state.channels[0];
        primary.name = p.label;
        primary.psk = new Uint8Array([1]);
      }
    }
    renderLora();
    renderChannels();
  });

  document.getElementById("freqOffset").addEventListener("input", e => { state.lora.frequencyOffset = parseFloat(e.target.value) || 0; });
  document.getElementById("overrideFreq").addEventListener("input", e => { state.lora.overrideFrequency = parseFloat(e.target.value) || 0; });
  document.getElementById("bandwidth").addEventListener("input", e => { if (!state.lora.usePreset) state.lora.bandwidth = parseFloat(e.target.value) || 0; });
  document.getElementById("spreadFactor").addEventListener("input", e => { if (!state.lora.usePreset) state.lora.spreadFactor = parseInt(e.target.value, 10) || 0; });
  document.getElementById("codingRate").addEventListener("input", e => { if (!state.lora.usePreset) state.lora.codingRate = parseInt(e.target.value, 10) || 0; });

  document.getElementById("addChannelBtn").addEventListener("click", () => {
    if (state.channels.length >= 8) return;
    const wasEmpty = state.channels.length === 0;
    const ch = newChannel(`Channel${state.channels.length + 1}`);
    if (wasEmpty) ch.isPrimary = true;
    state.channels.push(ch);
    renderChannels();
  });

  document.getElementById("decodeBtn").addEventListener("click", () => {
    decodeAndLoad(document.getElementById("decodeUrl").value.trim());
  });

  document.getElementById("encodeBtn").addEventListener("click", () => {
    const out = document.getElementById("encodeResult");
    try {
      const bytes = buildChannelSet(document.getElementById("clearHidden").checked);
      const b64url = bytesToBase64url(bytes);
      const url = `https://meshtastic.org/e/#${b64url}`;
      out.textContent = url;
      QRCode.toCanvas(document.getElementById("qrcode"), url, err => {
        if (err) out.textContent += "\n\nQR render error: " + err.message;
      });
    } catch (err) {
      out.textContent = "Error: " + err.message;
    }
  });

  document.getElementById("qrUpload").addEventListener("change", e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = event => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        const size = Math.max(img.width, img.height);
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#FFFFFF";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, (size - img.width) / 2, (size - img.height) / 2);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, canvas.width, canvas.height);
        if (code && code.data) {
          document.getElementById("decodeUrl").value = code.data;
          decodeAndLoad(code.data);
        } else {
          setQrStatus("QR code not recognized.", "fail");
        }
      };
      img.src = event.target.result;
    };
    reader.readAsDataURL(file);
  });
}

init();
