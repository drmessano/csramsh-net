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
  LONG_TURBO = 9;
}

enum FemLnaMode {
  DISABLED = 0;
  ENABLED = 1;
  NOT_PRESENT = 2;
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
  bool ignore_mqtt = 104;
  bool config_ok_to_mqtt = 105;
  FemLnaMode fem_lna_mode = 106;
  bool serial_hal_only = 107;
}

message ModuleSettings {
  uint32 position_precision = 1;
  bool is_muted = 2;
}

message ChannelSettings {
  bytes psk = 2;
  string name = 3;
  fixed32 id = 4;
  bool uplink_enabled = 5;
  bool downlink_enabled = 6;
  ModuleSettings module_settings = 7;
}

message ChannelSet {
  repeated ChannelSettings settings = 1;
  LoRaConfig lora_config = 2;
}
`;

// Bandwidth (kHz) / Spread Factor / Coding Rate per preset, matching
// Meshtastic firmware's current modemPresetToParams() (src/mesh/MeshRadio.h,
// non-wide/non-2.4GHz values). VERY_LONG_SLOW (2) is deliberately absent —
// it has no case in that switch at all and silently behaves as LongFast;
// its enum value is kept in PROTO_DEF only so decoding an old config that
// specifies it doesn't break. LONG_SLOW (1) is still implemented but is
// marked [deprecated = true] in the real .proto.
const PRESETS = {
  0: { label: "LongFast", bandwidth: 250, spreadFactor: 11, codingRate: 5 },
  1: { label: "LongSlow", bandwidth: 125, spreadFactor: 12, codingRate: 8 },
  3: { label: "MediumSlow", bandwidth: 250, spreadFactor: 10, codingRate: 5 },
  4: { label: "MediumFast", bandwidth: 250, spreadFactor: 9, codingRate: 5 },
  5: { label: "ShortSlow", bandwidth: 250, spreadFactor: 8, codingRate: 5 },
  6: { label: "ShortFast", bandwidth: 250, spreadFactor: 7, codingRate: 5 },
  7: { label: "LongModerate", bandwidth: 125, spreadFactor: 11, codingRate: 8 },
  8: { label: "ShortTurbo", bandwidth: 500, spreadFactor: 7, codingRate: 5 },
  9: { label: "LongTurbo", bandwidth: 500, spreadFactor: 11, codingRate: 8 },
};

// Not a real Meshtastic firmware preset — a local shortcut for CSRA Mesh's
// own custom radio settings. Selecting it is equivalent to Custom mode
// (use_preset stays false; there's no matching ModemPreset value) with
// these values pre-filled instead of typed in by hand.
// psk 0x09 is "Simple8" — the protocol's own 1-byte shorthand scheme
// (ChannelSettings.psk doc: byte 1 = "Default", bytes 2-10 = Simple1-9,
// each just the default key with its last byte incremented). A real,
// firmware-recognized short key, distinct from the Default key ("AQ==")
// every other preset uses. Base64-encodes as "CQ==" — chosen specifically
// because that's all-uppercase (a 1-byte key's base64 is only 2 real
// characters + "==", and most byte values produce a lowercase second
// character, e.g. 0x02 -> "Ag=="). A true short mnemonic like "CSRA=="
// isn't possible — Meshtastic PSKs must be exactly 0, 1, 16, or 32 bytes,
// so anything longer than 1 byte has to jump straight to a full 16/32-byte
// key.
const CSRA_PRESET = { label: "CSRA", bandwidth: 500, spreadFactor: 9, codingRate: 5, channelNum: 6, psk: new Uint8Array([9]) };

// Region is not exposed in the UI; every encoded config is hardcoded to US.
const REGION_US = 1;

// ModuleSettings.position_precision is "bits of position precision" (proto
// comment) — 0 = never send location on this channel, 32 = full/exact
// location, and 10-19 are the practical obfuscated range the official apps
// let you pick from (per meshtastic.org/docs/configuration/radio/channels).
// Labels spell out the actual distance so the number in the dropdown means
// something at a glance — the Channels panel is allowed to grow past 900px
// to fit this instead of squeezing it down to bare numbers.
const PRECISION_LEVELS = [
  { value: 0, label: "Disabled (no position)" },
  { value: 10, label: "10 (~23.3 km / 14.5 mi)" },
  { value: 11, label: "11 (~11.7 km / 7.3 mi)" },
  { value: 12, label: "12 (~5.8 km / 3.6 mi)" },
  { value: 13, label: "13 (~2.9 km / 1.8 mi)" },
  { value: 14, label: "14 (~1.5 km / 4787 ft)" },
  { value: 15, label: "15 (~729 m / 2392 ft)" },
  { value: 16, label: "16 (~364 m / 1194 ft)" },
  { value: 17, label: "17 (~182 m / 597 ft)" },
  { value: 18, label: "18 (~91 m / 299 ft)" },
  { value: 19, label: "19 (~45 m / 148 ft)" },
  { value: 32, label: "Precise (full accuracy)" },
];

let root = null;

function randomId() {
  return crypto.getRandomValues(new Uint32Array(1))[0] >>> 0;
}

function newChannel(name) {
  return {
    name: name || "", psk: new Uint8Array(0), uplink: false, downlink: false,
    id: randomId(), pskEditable: false, isPrimary: false,
    positionPrecision: 0, isMuted: false,
  };
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
    // Which dropdown option is showing. Needed because both "Custom" and
    // "CSRA" share usePreset:false (neither matches a real ModemPreset
    // value), so usePreset/modemPreset alone can't tell them apart.
    presetSelection: "0",
    bandwidth: PRESETS[0].bandwidth,
    spreadFactor: PRESETS[0].spreadFactor,
    codingRate: PRESETS[0].codingRate,
    hopLimit: 3,
    channelNum: 0,
    ignoreMqtt: false,
    configOkToMqtt: false,
    // Not exposed in the UI, but NOT safe to omit from the encoded output —
    // set_config.lora is a full struct replace on the device (confirmed
    // against firmware's AdminModule.cpp: `config.lora = validatedLora;`),
    // so any field we don't send gets reset to its proto3 zero-value. For
    // tx_enabled and sx126x_rx_boosted_gain that zero-value is destructive
    // (an omitted tx_enabled reads back as false — TX gets disabled on
    // reboot), so these default to their real firmware defaults instead of
    // being left out. txPower/overrideDutyCycle/overrideFrequency/
    // paFanDisabled/serialHalOnly/frequencyOffset are genuinely safe at 0/
    // false (their doc comments confirm 0 means "use the board's own safe
    // default"), so those stay hardcoded at encode time. femLnaMode's safe
    // default is NOT_PRESENT (2), not DISABLED (0) — firmware only disables
    // a real LNA when it sees DISABLED explicitly; NOT_PRESENT is treated
    // the same as ENABLED on hardware that actually has one.
    txEnabled: true,
    sx126xRxBoostedGain: true,
    femLnaMode: 2,
  },
  // Variable-length: only channels actually defined live here (1-8 entries).
  // Which one is primary is tracked by isPrimary, not by array position — the
  // list order (and each row's #) never changes when you switch Primary; the
  // array is only reordered momentarily at encode time, since the Meshtastic
  // wire format itself has no role field and infers primary from position 0.
  channels: [
    { name: "LongFast", psk: new Uint8Array([1]), uplink: false, downlink: false, id: randomId(), pskEditable: false, isPrimary: true, positionPrecision: 0, isMuted: false },
  ],
};

// Number of distinct frequency slots for a given bandwidth in the US region
// — the only region this tool encodes. Matches RadioInterface.cpp exactly:
// numChannels = floor((freqEnd - freqStart) / (spacing + bw/1000)), and for
// US: freqStart=902.0, freqEnd=928.0 (MHz), spacing=0. channel_num 0 means
// "auto-select via name hash", so 0 is always valid regardless of bandwidth;
// 1..maxChannelNum address genuinely distinct slots without wrapping.
function maxChannelNumFor(bwKHz) {
  return Math.floor(26000 / bwKHz);
}

function renderLora() {
  const presetSel = document.getElementById("preset");
  presetSel.value = state.lora.presetSelection;
  document.getElementById("bandwidth").value = state.lora.bandwidth;
  document.getElementById("spreadFactor").value = state.lora.spreadFactor;
  document.getElementById("codingRate").value = state.lora.codingRate;

  const channelNumEl = document.getElementById("channelNum");
  const maxChannelNum = maxChannelNumFor(state.lora.bandwidth);
  if (state.lora.channelNum > maxChannelNum) state.lora.channelNum = maxChannelNum;
  channelNumEl.max = maxChannelNum;
  channelNumEl.value = state.lora.channelNum;

  document.getElementById("ignoreMqtt").checked = state.lora.ignoreMqtt;
  document.getElementById("configOkToMqtt").checked = state.lora.configOkToMqtt;

  // Locked whenever a preset (real or CSRA) is selected — only "Custom"
  // unlocks these. Deliberately NOT the same thing as state.lora.usePreset:
  // CSRA has to stay usePreset:false on the wire (no real ModemPreset
  // matches its numbers), but that's a wire-format fact, not a reason to
  // let its fields be edited — that's what Custom is for.
  const locked = state.lora.presetSelection !== "custom";
  ["bandwidth", "spreadFactor", "codingRate"].forEach(id => {
    document.getElementById(id).disabled = locked;
  });
  channelNumEl.readOnly = locked;
  channelNumEl.classList.toggle("locked", locked);
  scheduleRegenerateOutput();
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
    nameInput.addEventListener("input", () => { ch.name = nameInput.value; scheduleRegenerateOutput(); });
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
        scheduleRegenerateOutput();
      } catch (e) {
        pskVal.classList.add("input-error");
      }
    });

    const tdUp = document.createElement("td");
    const cbUp = document.createElement("input");
    cbUp.type = "checkbox";
    cbUp.title = "Uplink: relay this channel's traffic to MQTT";
    cbUp.checked = !!ch.uplink;
    cbUp.addEventListener("change", () => { ch.uplink = cbUp.checked; scheduleRegenerateOutput(); });
    tdUp.appendChild(cbUp);

    const tdDown = document.createElement("td");
    const cbDown = document.createElement("input");
    cbDown.type = "checkbox";
    cbDown.title = "Downlink: relay MQTT traffic into this channel";
    cbDown.checked = !!ch.downlink;
    cbDown.addEventListener("change", () => { ch.downlink = cbDown.checked; scheduleRegenerateOutput(); });
    tdDown.appendChild(cbDown);

    const tdMuted = document.createElement("td");
    const cbMuted = document.createElement("input");
    cbMuted.type = "checkbox";
    cbMuted.title = "Mute: silence notifications for messages on this channel";
    cbMuted.checked = !!ch.isMuted;
    cbMuted.addEventListener("change", () => { ch.isMuted = cbMuted.checked; scheduleRegenerateOutput(); });
    tdMuted.appendChild(cbMuted);

    const tdPrecision = document.createElement("td");
    const selPrecision = document.createElement("select");
    selPrecision.className = "precision-sel";
    selPrecision.title = "Bits of location precision shared on this channel";
    PRECISION_LEVELS.forEach(p => {
      const opt = document.createElement("option");
      opt.value = p.value;
      opt.textContent = p.label;
      selPrecision.appendChild(opt);
    });
    selPrecision.value = ch.positionPrecision || 0;
    selPrecision.addEventListener("change", () => { ch.positionPrecision = Number(selPrecision.value); scheduleRegenerateOutput(); });
    tdPrecision.appendChild(selPrecision);

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

    tr.append(tdIdx, tdRole, tdName, tdPskEdit, tdPskVal, tdUp, tdDown, tdMuted, tdPrecision, tdDel);
    tbody.appendChild(tr);
  });

  document.getElementById("addChannelBtn").disabled = state.channels.length >= 8;
  scheduleRegenerateOutput();
}

function setQrStatus(text, cls) {
  const el = document.getElementById("qrStatus");
  el.textContent = text;
  el.className = cls || "";
}

// Walks the raw ChannelSet wire bytes to find each `settings` (field 1)
// entry's ORIGINAL byte length — independent of which sub-fields our schema
// happens to declare. A entry a real device actually configured but using
// only fields our UI leaves at their default (e.g. module_settings set but
// every other field blank) is non-zero-length here even though it decodes
// to an all-blank object; a true placeholder/padding slot is genuinely 0
// bytes. That distinction is impossible to make from the decoded object
// alone, since a default-valued field and an absent one look identical.
function getSettingsRawLengths(bytes) {
  let i = 0;
  const lengths = [];
  function readVarint() {
    let result = 0, shift = 0;
    while (true) {
      const byte = bytes[i++];
      result |= (byte & 0x7f) << shift;
      if (!(byte & 0x80)) return result >>> 0;
      shift += 7;
    }
  }
  while (i < bytes.length) {
    const tag = readVarint();
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x7;
    if (wireType === 0) {
      readVarint();
    } else if (wireType === 2) {
      const len = readVarint();
      if (fieldNum === 1) lengths.push(len);
      i += len;
    } else if (wireType === 5) {
      i += 4;
    } else if (wireType === 1) {
      i += 8;
    } else {
      throw new Error("Unsupported wire type " + wireType + " in ChannelSet");
    }
  }
  return lengths;
}

async function decodeConfig(rawInput) {
  const frag = extractFragment(rawInput);
  const bytes = base64urlToBytes(frag);
  const ChannelSet = root.lookupType("ChannelSet");
  const msg = ChannelSet.decode(bytes);
  // defaults:false (the default) is what we want here: protobufjs omits a
  // field from the object entirely when its decoded value equals the type's
  // zero-value, which for proto3 is indistinguishable from "never set" —
  // exactly the same "was this actually asserted" question buildChannelSet
  // answers on the encode side. defaults:true would force every LoRaConfig
  // field to print (as 0/false) even when our own encoder (or a real
  // device's export) never wrote it at all, which is misleading here.
  const obj = ChannelSet.toObject(msg);
  obj.__settingsRawLengths = getSettingsRawLengths(bytes);
  return obj;
}

function loadStateFromDecoded(obj) {
  const lora = obj.loraConfig || {};
  state.lora.usePreset = !!lora.usePreset;
  state.lora.modemPreset = lora.modemPreset || 0;
  state.lora.presetSelection = state.lora.usePreset ? String(state.lora.modemPreset) : "custom";
  state.lora.hopLimit = lora.hopLimit || 0;
  state.lora.channelNum = lora.channelNum || 0;
  state.lora.ignoreMqtt = !!lora.ignoreMqtt;
  state.lora.configOkToMqtt = !!lora.configOkToMqtt;
  // Proto3 omits a field that's exactly its zero-value, so a decoded config
  // can never actually distinguish "explicitly false/DISABLED" from "never
  // set" here — real device exports have the same limitation (confirmed:
  // one never includes use_preset/modem_preset when both are 0). Given
  // that ambiguity, and that the zero-value for these three is destructive
  // (see the default block above), always resolve the absent case to the
  // safe default rather than silently carrying a false/DISABLED forward.
  state.lora.txEnabled = "txEnabled" in lora ? !!lora.txEnabled : true;
  state.lora.sx126xRxBoostedGain = "sx126xRxBoostedGain" in lora ? !!lora.sx126xRxBoostedGain : true;
  state.lora.femLnaMode = "femLnaMode" in lora ? lora.femLnaMode : 2;

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

  // Real exports pad the settings array with placeholder entries for unused
  // channel slots, genuinely 0 bytes on the wire. Blindly turning every array
  // entry into a visible row resurrected those as phantom "Secondary"
  // channels. Whether a slot is real is decided by its ORIGINAL raw byte
  // length (see getSettingsRawLengths) — never by whether the fields we
  // parse are all default, since a field explicitly set to its zero value
  // (e.g. position_precision: 0) is indistinguishable from one never set.
  const settings = obj.settings || [];
  const rawLengths = obj.__settingsRawLengths || [];
  state.channels = settings.slice(0, 8)
    .map((s, i) => ({
      name: s.name || "",
      psk: s.psk instanceof Uint8Array ? s.psk : new Uint8Array(0),
      uplink: !!s.uplinkEnabled,
      downlink: !!s.downlinkEnabled,
      // Preserve exactly what was decoded — including a genuine id of 0.
      // Substituting a random id here (as this used to) fabricates new
      // data for a channel that never had any, and changes its re-encoded
      // bytes even when nothing was edited.
      id: s.id || 0,
      positionPrecision: (s.moduleSettings && s.moduleSettings.positionPrecision) || 0,
      isMuted: !!(s.moduleSettings && s.moduleSettings.isMuted),
      // Reflects what was actually decoded, not a fixed default — a channel
      // that came in with real key bytes should show them (checked, PSK
      // field populated), not silently hide a PSK that's genuinely present.
      pskEditable: s.psk instanceof Uint8Array && s.psk.length > 0,
      isPrimary: i === 0,
      _rawLength: rawLengths[i],
    }))
    .filter(ch => ch.isPrimary || ch._rawLength > 0)
    .map(({ _rawLength, ...ch }) => ch);
  if (state.channels.length === 0) state.channels = [newChannel("")];
  if (!state.channels.some(c => c.isPrimary)) state.channels[0].isPrimary = true;
}

function buildChannelSet() {
  const ChannelSet = root.lookupType("ChannelSet");
  // The wire format has no role field — it infers primary from position 0 —
  // so the primary-flagged channel is moved to the front only here, at encode
  // time. The on-screen row order/# is unaffected by this.
  const primaryIdx = state.channels.findIndex(c => c.isPrimary);
  const ordered = primaryIdx > 0
    ? [state.channels[primaryIdx], ...state.channels.filter((_, idx) => idx !== primaryIdx)]
    : state.channels;
  // Only include a key when it's not the type's zero-value. protobufjs's
  // reflection encode writes a field whenever it's a present own-property —
  // it does NOT skip it just because the value equals the default the way
  // proto3 wire format is supposed to. Always including every key (as this
  // used to) meant a fully-blank channel could never encode to true 0 bytes,
  // which is exactly the signal both real devices and our own decode filter
  // use to recognize a channel slot as absent/disabled. Real Meshtastic
  // exports only ever include fields that are actually set, for the same
  // reason.
  const settings = ordered.map(ch => {
    const s = {};
    if (ch.name) s.name = ch.name;
    if (ch.psk && ch.psk.length > 0) s.psk = ch.psk;
    if (ch.uplink) s.uplinkEnabled = true;
    if (ch.downlink) s.downlinkEnabled = true;
    if (ch.id) s.id = ch.id >>> 0;
    const moduleSettings = {};
    if (ch.positionPrecision) moduleSettings.positionPrecision = ch.positionPrecision;
    if (ch.isMuted) moduleSettings.isMuted = true;
    if (Object.keys(moduleSettings).length > 0) s.moduleSettings = moduleSettings;
    return s;
  });

  // frequencyOffset/txPower/overrideDutyCycle/overrideFrequency/
  // paFanDisabled/serialHalOnly are omitted — a real device's own
  // set_config.lora handler does a full struct replace (confirmed against
  // firmware's AdminModule.cpp), so an omitted field resets to its proto3
  // zero-value on the receiving device, and 0/false genuinely IS the safe,
  // documented default for all six of these (e.g. tx_power's doc comment:
  // "if zero, use default max legal continuous power").
  //
  // txEnabled, sx126xRxBoostedGain, and femLnaMode are NOT safe to omit the
  // same way — their zero-value is destructive (tx_enabled:false disables
  // the transmitter entirely; femLnaMode:DISABLED turns off a real front-end
  // amplifier). A previous version of this tool omitted them too, which
  // silently killed TX on any device that applied the resulting QR. They're
  // always included now, sourced from state (preserved on decode, or a safe
  // default for a config built from scratch — see the state.lora comment).
  const loraConfig = {
    usePreset: state.lora.usePreset,
    modemPreset: state.lora.modemPreset,
    bandwidth: state.lora.bandwidth,
    spreadFactor: state.lora.spreadFactor,
    codingRate: state.lora.codingRate,
    region: REGION_US,
    hopLimit: state.lora.hopLimit,
    txEnabled: state.lora.txEnabled,
    channelNum: state.lora.channelNum,
    sx126xRxBoostedGain: state.lora.sx126xRxBoostedGain,
    ignoreMqtt: state.lora.ignoreMqtt,
    configOkToMqtt: state.lora.configOkToMqtt,
    femLnaMode: state.lora.femLnaMode,
  };

  const payload = { settings, loraConfig };
  const ChannelSetType = ChannelSet;
  const errMsg = ChannelSetType.verify(payload);
  if (errMsg) throw new Error(errMsg);
  const msg = ChannelSetType.create(payload);
  return ChannelSetType.encode(msg).finish();
}

// Rebuilds the URL + QR from current state right now. Called directly by
// the button click (immediate) and via scheduleRegenerateOutput elsewhere
// (debounced, so typing doesn't redraw the QR on every keystroke).
function regenerateOutput() {
  const out = document.getElementById("encodeResult");
  const downloadBtn = document.getElementById("downloadQrBtn");
  const shareBtn = document.getElementById("shareQrBtn");
  const copyBtn = document.getElementById("copyUrlBtn");
  downloadBtn.disabled = true;
  shareBtn.disabled = true;
  copyBtn.disabled = true;
  try {
    const bytes = buildChannelSet();
    const b64url = bytesToBase64url(bytes);
    const url = `https://meshtastic.org/e/#${b64url}`;
    out.textContent = url;
    copyBtn.disabled = false;

    // qr.html?url=<fragment> is its own minimal page that just renders a QR
    // for the meshtastic.org URL — a link to it (not to this editor) so it
    // can be shared/scanned on its own. Resolved against this page's own
    // location so it works regardless of where the site is deployed.
    const shareUrl = new URL(`qr.html?url=${b64url}`, window.location.href).href;
    document.getElementById("qrLink").href = shareUrl;
    shareBtn.disabled = false;

    QRCode.toCanvas(document.getElementById("qrcode"), url, err => {
      if (err) {
        out.textContent += "\n\nQR render error: " + err.message;
      } else {
        downloadBtn.disabled = false;
      }
    });
  } catch (err) {
    out.textContent = "Error: " + err.message;
  }
}

let regenerateTimer = null;
let decodeTimer = null;
function scheduleRegenerateOutput() {
  clearTimeout(regenerateTimer);
  regenerateTimer = setTimeout(regenerateOutput, 200);
}

function jsonReplacer(key, value) {
  if (key === "__settingsRawLengths") return undefined; // internal bookkeeping, not real protobuf content
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
    }).catch(err => {
      out.textContent = "Error: " + err.message;
    });
  } catch (err) {
    out.textContent = "Error: " + err.message;
  }
}

function init() {
  root = protobuf.parse(PROTO_DEF).root;

  renderLora();
  renderChannels();

  document.getElementById("preset").addEventListener("change", e => {
    const val = e.target.value;
    state.lora.presetSelection = val;
    if (val === "custom") {
      state.lora.usePreset = false;
      // Custom implies nothing about the primary channel — no name, no
      // particular key — so don't leave the previous preset's values (e.g.
      // "LongFast" / its Default key) sitting there looking like a choice
      // that was actually made.
      const primary = state.channels.find(c => c.isPrimary) || state.channels[0];
      if (primary) {
        primary.name = "";
        primary.psk = new Uint8Array(0);
        primary.pskEditable = false;
      }
    } else {
      // Both a real firmware preset and CSRA (our own local shortcut, not
      // a real ModemPreset) populate bandwidth/SF/CR/frequency slot and the
      // primary channel the same way; only where the numbers come from
      // differs.
      const isCsra = val === "csra";
      const p = isCsra ? CSRA_PRESET : PRESETS[Number(val)];
      state.lora.usePreset = !isCsra;
      state.lora.modemPreset = isCsra ? 0 : Number(val);
      state.lora.bandwidth = p.bandwidth;
      state.lora.spreadFactor = p.spreadFactor;
      state.lora.codingRate = p.codingRate;
      state.lora.channelNum = p.channelNum || 0;
      const presetPsk = p.psk || new Uint8Array([1]); // the well-known Default key unless the preset specifies its own

      if (state.channels.length === 0) {
        const primary = newChannel(p.label);
        primary.psk = presetPsk;
        primary.pskEditable = true;
        primary.isPrimary = true;
        state.channels.push(primary);
      } else {
        const primary = state.channels.find(c => c.isPrimary) || state.channels[0];
        primary.name = p.label;
        primary.psk = presetPsk;
        primary.pskEditable = true;
      }
    }
    renderLora();
    renderChannels();
  });

  // Frequency Slot's valid range depends on Bandwidth, so clamp against the
  // current max on every edit rather than only on blur/re-render.
  document.getElementById("channelNum").addEventListener("input", e => {
    if (state.lora.presetSelection !== "custom") return;
    const n = parseInt(e.target.value, 10) || 0;
    state.lora.channelNum = Math.max(0, Math.min(n, maxChannelNumFor(state.lora.bandwidth)));
    scheduleRegenerateOutput();
  });
  document.getElementById("ignoreMqtt").addEventListener("change", e => { state.lora.ignoreMqtt = e.target.checked; scheduleRegenerateOutput(); });
  document.getElementById("configOkToMqtt").addEventListener("change", e => { state.lora.configOkToMqtt = e.target.checked; scheduleRegenerateOutput(); });
  // Bandwidth/Spread Factor/Coding Rate are now <select> elements (only the
  // LoRa PHY's actual legal values are offered), so "change" fires on pick
  // rather than "input" on keystroke. Re-render after a bandwidth change so
  // Frequency Slot's dynamic max/clamp stays in sync with it.
  document.getElementById("bandwidth").addEventListener("change", e => {
    if (state.lora.presetSelection !== "custom") return;
    state.lora.bandwidth = parseFloat(e.target.value) || 0;
    renderLora();
  });
  document.getElementById("spreadFactor").addEventListener("change", e => { if (state.lora.presetSelection === "custom") { state.lora.spreadFactor = parseInt(e.target.value, 10) || 0; scheduleRegenerateOutput(); } });
  document.getElementById("codingRate").addEventListener("change", e => { if (state.lora.presetSelection === "custom") { state.lora.codingRate = parseInt(e.target.value, 10) || 0; scheduleRegenerateOutput(); } });

  document.getElementById("addChannelBtn").addEventListener("click", () => {
    if (state.channels.length >= 8) return;
    const wasEmpty = state.channels.length === 0;
    const ch = newChannel(`Channel${state.channels.length + 1}`);
    if (wasEmpty) ch.isPrimary = true;
    state.channels.push(ch);
    renderChannels();
  });

  // Auto-decode as you type/paste, debounced so it doesn't try mid-paste or
  // on every keystroke of manual entry. Covers a real Cmd/Ctrl+V paste into
  // the field directly; the Paste button below triggers decode itself since
  // setting .value via JS doesn't fire this event.
  document.getElementById("decodeUrl").addEventListener("input", e => {
    clearTimeout(decodeTimer);
    const value = e.target.value.trim();
    if (!value) {
      document.getElementById("decodeResult").textContent = "";
      return;
    }
    decodeTimer = setTimeout(() => decodeAndLoad(value), 400);
  });

  document.getElementById("downloadQrBtn").addEventListener("click", () => {
    const canvas = document.getElementById("qrcode");
    const link = document.createElement("a");
    link.download = "meshtastic-channel-qr.png";
    link.href = canvas.toDataURL("image/png");
    link.click();
  });

  document.getElementById("copyUrlBtn").addEventListener("click", async () => {
    const btn = document.getElementById("copyUrlBtn");
    const text = document.getElementById("encodeResult").textContent;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      const original = btn.textContent;
      btn.textContent = "Copied!";
      setTimeout(() => { btn.textContent = original; }, 1500);
    } catch (err) {
      setQrStatus("Could not copy to clipboard: " + err.message, "fail");
    }
  });

  // Copies the link to qr.html?url=... (this QR's own shareable page), not
  // the meshtastic.org URL itself — same link as right-clicking the QR
  // above and copying it that way.
  document.getElementById("shareQrBtn").addEventListener("click", async () => {
    const btn = document.getElementById("shareQrBtn");
    const shareUrl = document.getElementById("qrLink").href;
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      const original = btn.textContent;
      btn.textContent = "Copied!";
      setTimeout(() => { btn.textContent = original; }, 1500);
    } catch (err) {
      setQrStatus("Could not copy to clipboard: " + err.message, "fail");
    }
  });

  document.getElementById("pasteUrlBtn").addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      document.getElementById("decodeUrl").value = text;
      // Setting .value via JS doesn't fire an "input" event, so the
      // auto-decode listener above wouldn't otherwise see this.
      clearTimeout(decodeTimer);
      decodeAndLoad(text.trim());
    } catch (err) {
      setQrStatus("Could not read clipboard: " + err.message, "fail");
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

  applyPresetFromQueryString();
}

// Lets a link pre-select a preset on load, e.g. channel-endec.html?preset=CSRA
// (also accepts the raw option value, e.g. ?preset=csra or ?preset=9).
// Matching is case-insensitive against the dropdown's visible label.
function applyPresetFromQueryString() {
  const presetParam = new URLSearchParams(window.location.search).get("preset");
  if (!presetParam) return;

  const presetSel = document.getElementById("preset");
  const options = [...presetSel.options];
  const needle = presetParam.trim().toLowerCase();
  const match = options.find(o => o.value.toLowerCase() === needle)
    || options.find(o => o.textContent.trim().toLowerCase() === needle);
  if (!match) return;

  presetSel.value = match.value;
  presetSel.dispatchEvent(new Event("change"));
}

init();
