#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig } from '../src/config.js';

const execFileAsync = promisify(execFile);
const config = loadConfig();

const COMMANDS = [
  'commands',
  'identity',
  'services',
  'policy',
  'health',
  'status',
  'doctor',
  'metrics'
];

const SERVICE_LABELS = {
  all: [
    'com.project-manhattan.agent',
    'com.project-manhattan.daemon'
  ],
  lab512: [
    'com.minilab.mistralrs-serve'
  ],
  lab8gb: [
    'local.lab-mistral-gateway',
    'local.lab-bridge-watchdog'
  ]
};

const DEFAULT_MANHATTAN_POLICY = '/usr/local/project-manhattan/etc/PROJECT_MANHATTAN_POLICY_REVIEW.json';

const args = process.argv.slice(2);
const command = args.find((arg) => !arg.startsWith('-')) || 'status';
const pretty = args.includes('--pretty');

if (!COMMANDS.includes(command)) {
  printJson({
    ok: false,
    error: `unknown command: ${command}`,
    commands: COMMANDS
  });
  process.exit(2);
}

const payload = await runCommand(command);

if (command === 'metrics') {
  process.stdout.write(payload);
} else {
  printJson(payload);
}

if (command === 'doctor' || command === 'health' || command === 'status') {
  if (payload.ok === false) process.exitCode = 1;
}

async function runCommand(name) {
  if (name === 'commands') return commandsPayload();
  if (name === 'identity') return identityPayload();
  if (name === 'services') return await servicesPayload();
  if (name === 'policy') return policyPayload();
  if (name === 'health') return await healthPayload();
  if (name === 'status' || name === 'doctor') return await statusPayload(name);
  if (name === 'metrics') return await metricsPayload();
}

function commandsPayload() {
  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    purpose: 'Small read-only bridge sidecar for Manhattan. It observes the golden bridge without carrying the full Manhattan CLI.',
    manhattanCliAudit: {
      fullCli: '/usr/local/project-manhattan/bin/manhattan',
      wrappers: {
        agent: '/usr/local/project-manhattan/bin/manhattan-agent -> manhattan agent',
        daemon: '/usr/local/project-manhattan/bin/manhattan-daemon -> manhattan daemon'
      },
      fullCommandsFound: [
        'audit [--write]',
        'repair [--apply] [--item <id>...]',
        'health',
        'status',
        'metrics',
        'receipts',
        'policy-items',
        'daemon',
        'agent',
        'gc [--apply]'
      ],
      bridgeActuallyNeeds: [
        'identity',
        'services',
        'policy',
        'health',
        'status',
        'metrics'
      ],
      intentionallyNotIncluded: [
        'repair loops',
        'receipt garbage collection',
        'policy engine',
        'daemon or agent runtime',
        'HTML dashboard',
        'model weights',
        'mistralrs binary'
      ]
    },
    sidecarCommands: COMMANDS,
    stableUse: [
      'node scripts/manhattan-bridge.js status --pretty',
      'node scripts/manhattan-bridge.js health',
      'node scripts/manhattan-bridge.js metrics'
    ]
  };
}

function identityPayload() {
  const localIps = localIPv4s();
  const host = os.hostname();
  const lowerHost = host.toLowerCase();
  let detected = 'unknown';

  if (lowerHost === config.bridge.lab512.host.toLowerCase() || localIps.includes(config.bridge.lab512.ip)) {
    detected = 'lab512';
  } else if (lowerHost === config.bridge.lab8gb.host.toLowerCase() || localIps.includes(config.bridge.lab8gb.ip)) {
    detected = 'lab8gb';
  }

  const role = detected === 'lab512'
    ? config.bridge.lab512.role
    : detected === 'lab8gb'
      ? config.bridge.lab8gb.role
      : 'unknown';

  const expectedIp = detected === 'lab512'
    ? config.bridge.lab512.ip
    : detected === 'lab8gb'
      ? config.bridge.lab8gb.ip
      : null;

  const peer = detected === 'lab512'
    ? { host: config.bridge.lab8gb.host, ip: config.bridge.lab8gb.ip, role: config.bridge.lab8gb.role }
    : detected === 'lab8gb'
      ? { host: config.bridge.lab512.host, ip: config.bridge.lab512.ip, role: config.bridge.lab512.role }
      : null;

  const chair = modelChair();

  return {
    ok: detected !== 'unknown' && (!expectedIp || localIps.includes(expectedIp)),
    checkedAt: new Date().toISOString(),
    bridge: config.bridge.name,
    detectedHost: detected,
    labId: detected === 'lab512' ? 'LAB_512' : detected === 'lab8gb' ? 'LAB_8GB' : 'UNKNOWN',
    role,
    hostname: host,
    localIps,
    expectedIp,
    peer,
    route: {
      gateway: `${config.gateway.publicBaseUrl}/v1`,
      inference: `http://${config.mistral.host}:${config.mistral.port}/v1`,
      cable: `${config.bridge.lab8gb.ip} <-> ${config.bridge.lab512.ip}`
    },
    modelChair: chair
  };
}

async function servicesPayload() {
  const identity = identityPayload();
  const required = requiredLabelsFor(identity.detectedHost);
  const deleted = config.bridge.deletedLaunchLabels || [];
  const warning = config.bridge.warningLaunchLabels || [];
  const launch = await launchctlSnapshot([...required, ...deleted, ...warning]);

  const requiredRows = required.map((label) => serviceRow(label, launch, 'required'));
  const deletedRows = deleted.map((label) => serviceRow(label, launch, 'must_be_absent'));
  const warningRows = warning.map((label) => serviceRow(label, launch, 'warning_if_present'));
  const requiredOk = requiredRows.every((row) => row.present);
  const deletedOk = deletedRows.every((row) => !row.present);

  return {
    ok: launch.ok && requiredOk && deletedOk,
    checkedAt: new Date().toISOString(),
    detectedHost: identity.detectedHost,
    launchctl: launch.ok ? 'available' : launch.error,
    required: requiredRows,
    mustBeAbsent: deletedRows,
    warnings: warningRows
  };
}

function policyPayload() {
  const policyPath = process.env.MANHATTAN_POLICY || DEFAULT_MANHATTAN_POLICY;
  const out = {
    ok: true,
    checkedAt: new Date().toISOString(),
    policyPath,
    checks: []
  };

  if (!fs.existsSync(policyPath)) {
    out.ok = false;
    out.checks.push({ name: 'manhattan policy exists', ok: false, detail: 'missing' });
    return out;
  }

  let policy;
  try {
    policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
    out.checks.push({ name: 'manhattan policy parses', ok: true, detail: policy.schema_version || 'json' });
  } catch (error) {
    out.ok = false;
    out.checks.push({ name: 'manhattan policy parses', ok: false, detail: error.message });
    return out;
  }

  const pair = policy.hosts?.pair_8gb_512_values_requiring_daniel || {};
  check(out, 'LAB 8GB bridge IP', pair.lab_8gb_ethernet_ip === config.bridge.lab8gb.ip, pair.lab_8gb_ethernet_ip);
  check(out, 'LAB 512 bridge IP', pair.lab_512_ethernet_ip === config.bridge.lab512.ip, pair.lab_512_ethernet_ip);

  const rows = Array.isArray(policy.registry_required_by_document)
    ? policy.registry_required_by_document
    : Array.isArray(policy.launchd_registry)
      ? policy.launchd_registry
      : [];
  check(out, 'launchd registry present', rows.length > 0, `${rows.length} rows`);
  const llmGateway = rows.find((row) => row.label === 'com.minilab.llm-gateway');
  check(out, 'old llm gateway retired', Boolean(llmGateway?.status?.includes('retired')), llmGateway?.status || 'missing');
  check(out, 'old llm gateway points to golden bridge', llmGateway?.retirement?.superseded_by === config.bridge.name, llmGateway?.retirement || {});
  check(out, 'old gateway URL matches bridge', llmGateway?.retirement?.bridge_gateway === `${config.gateway.publicBaseUrl}/v1`, llmGateway?.retirement?.bridge_gateway || 'missing');
  check(out, 'old inference URL matches bridge', llmGateway?.retirement?.bridge_inference === `http://${config.bridge.lab512.ip}:${config.mistral.port}/v1`, llmGateway?.retirement?.bridge_inference || 'missing');

  for (const label of config.bridge.deletedLaunchLabels || []) {
    const row = rows.find((entry) => entry.label === label);
    const status = String(row?.status || 'missing').toLowerCase();
    const ok = !row || status.includes('deleted') || status.includes('retired') || status.includes('removed');
    check(out, `${label} policy is deleted/retired`, ok, row ? row.status : 'missing');
  }

  return out;
}

async function healthPayload() {
  const identity = identityPayload();
  const checks = [];

  await endpointCheck(checks, 'lab512 mistral health', `http://${config.bridge.lab512.ip}:${config.mistral.port}/health`);
  await endpointCheck(checks, 'lab512 mistral models', `http://${config.bridge.lab512.ip}:${config.mistral.port}/v1/models`, true);
  await endpointCheck(checks, 'lab8gb gateway health', `${config.gateway.publicBaseUrl}/health`, true);
  await endpointCheck(checks, 'lab8gb bridge state', `${config.gateway.publicBaseUrl}/ops/bridge`, true, {
    authorization: `Bearer ${process.env.LAB_GATEWAY_KEY || config.gateway.apiKey}`
  });

  return {
    ok: identity.ok && checks.every((entry) => entry.ok),
    checkedAt: new Date().toISOString(),
    detectedHost: identity.detectedHost,
    checks
  };
}

async function statusPayload(mode) {
  const identity = identityPayload();
  const [services, policy, health] = await Promise.all([
    servicesPayload(),
    Promise.resolve(policyPayload()),
    healthPayload()
  ]);

  return {
    ok: identity.ok && services.ok && policy.ok && health.ok,
    checkedAt: new Date().toISOString(),
    mode,
    bridge: config.bridge.name,
    identity,
    services,
    policy,
    health,
    guidance: [
      'LAB 512 holds model and mistralrs.',
      'LAB 8GB is gateway-only.',
      'Model file and mistralrs binary are rebuild prerequisites, not package payload.'
    ]
  };
}

async function metricsPayload() {
  const status = await statusPayload('metrics');
  const labels = `bridge="${escapeLabel(config.bridge.name)}",host="${escapeLabel(status.identity.detectedHost)}"`;
  const lines = [
    '# HELP golden_bridge_ok Overall sidecar health, 1 if every bridge check is ok.',
    '# TYPE golden_bridge_ok gauge',
    `golden_bridge_ok{${labels}} ${status.ok ? 1 : 0}`,
    '# HELP golden_bridge_identity_ok Host identity matches the bridge chair.',
    '# TYPE golden_bridge_identity_ok gauge',
    `golden_bridge_identity_ok{${labels}} ${status.identity.ok ? 1 : 0}`,
    '# HELP golden_bridge_services_ok Required services are present and deleted labels are absent.',
    '# TYPE golden_bridge_services_ok gauge',
    `golden_bridge_services_ok{${labels}} ${status.services.ok ? 1 : 0}`,
    '# HELP golden_bridge_policy_ok Manhattan bridge policy matches the golden bridge.',
    '# TYPE golden_bridge_policy_ok gauge',
    `golden_bridge_policy_ok{${labels}} ${status.policy.ok ? 1 : 0}`,
    '# HELP golden_bridge_endpoint_ok Endpoint check status.',
    '# TYPE golden_bridge_endpoint_ok gauge'
  ];

  for (const checkRow of status.health.checks) {
    lines.push(`golden_bridge_endpoint_ok{${labels},check="${escapeLabel(checkRow.name)}"} ${checkRow.ok ? 1 : 0}`);
  }

  lines.push('');
  return lines.join('\n');
}

function modelChair() {
  const model = config.models.find((entry) => entry.role === 'inference-512');
  const args = model?.args || [];
  const modelDir = valueAfter(args, '-m');
  const fileName = valueAfter(args, '-f');
  const expectedFile = modelDir && fileName ? path.join(modelDir, fileName) : null;
  const onDisk = expectedFile ? fs.existsSync(expectedFile) : null;

  return {
    packaged: false,
    gatewayModel: model?.id || null,
    upstreamModel: model?.modelId || null,
    quantization: model?.quantization || null,
    expectedModelFile: expectedFile,
    expectedModelFilePresentOnThisHost: onDisk,
    launchArgs: {
      prefixCacheDisabled: hasArgPair(config.mistral.extraArgs || [], '--prefix-cache-n', '0'),
      maxSeqs: valueAfter(config.mistral.extraArgs || [], '--max-seqs'),
      maxBatchSize: valueAfter(config.mistral.extraArgs || [], '--max-batch-size'),
      maxSeqLen: valueAfter(config.mistral.extraArgs || [], '--max-seq-len')
    },
    note: 'This is the model chair only. The package wires the slot; the model file is downloaded/restored separately on LAB 512.'
  };
}

function requiredLabelsFor(host) {
  const labels = [...SERVICE_LABELS.all];
  if (host === 'lab512') labels.push(...SERVICE_LABELS.lab512);
  if (host === 'lab8gb') labels.push(...SERVICE_LABELS.lab8gb);
  return labels;
}

function serviceRow(label, launch, expectation) {
  const entry = launch.labels.get(label);
  return {
    label,
    expectation,
    present: Boolean(entry),
    state: entry ? entry.state : 'missing',
    pid: entry?.pid ?? null,
    lastExitStatus: entry?.lastExitStatus ?? null
  };
}

async function launchctlList() {
  try {
    const { stdout } = await execFileAsync('launchctl', ['list'], { timeout: 5000 });
    const labels = new Map();
    for (const line of stdout.split('\n').slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) continue;
      const [pid, lastExitStatus, ...rest] = parts;
      const label = rest.join(' ');
      labels.set(label, {
        pid: pid === '-' ? null : Number(pid),
        lastExitStatus: lastExitStatus === '-' ? null : Number(lastExitStatus),
        state: pid === '-' ? 'loaded' : 'running'
      });
    }
    return { ok: true, labels };
  } catch (error) {
    return { ok: false, error: error.message, labels: new Map() };
  }
}

async function launchctlSnapshot(targetLabels) {
  const snapshot = await launchctlList();
  for (const label of targetLabels) {
    if (snapshot.labels.has(label)) continue;
    const probed = await probeLaunchctlLabel(label);
    if (probed.present) snapshot.labels.set(label, probed);
  }
  return snapshot;
}

async function probeLaunchctlLabel(label) {
  const domains = [`gui/${process.getuid()}`, 'system'];
  for (const domain of domains) {
    const direct = await launchctlPrint(domain, label);
    if (direct.present) return direct;
    if (domain === 'system') {
      const sudo = await launchctlPrint(domain, label, true);
      if (sudo.present) return sudo;
    }
  }
  return { present: false };
}

async function launchctlPrint(domain, label, sudo = false) {
  const target = `${domain}/${label}`;
  const command = sudo ? 'sudo' : 'launchctl';
  const args = sudo ? ['-n', 'launchctl', 'print', target] : ['print', target];
  try {
    const { stdout } = await execFileAsync(command, args, { timeout: 5000 });
    return {
      present: true,
      pid: numberFrom(stdout.match(/\bpid = (\d+)/)?.[1]),
      lastExitStatus: null,
      state: stdout.match(/\bstate = ([^\n]+)/)?.[1]?.trim() || 'loaded',
      domain,
      sudo
    };
  } catch {
    return { present: false };
  }
}

async function endpointCheck(checks, name, url, parseJson = false, headers = {}) {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    const text = await response.text();
    if (!response.ok) throw new Error(`${response.status}: ${text.slice(0, 300)}`);
    const detail = parseJson ? JSON.parse(text) : text.trim();
    checks.push({ name, ok: true, url, detail });
  } catch (error) {
    checks.push({ name, ok: false, url, detail: error.message });
  }
}

function check(out, name, ok, detail) {
  out.checks.push({ name, ok, detail });
  if (!ok) out.ok = false;
}

function localIPv4s() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address)
    .sort();
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}

function hasArgPair(args, flag, expected) {
  return valueAfter(args, flag) === expected;
}

function numberFrom(value) {
  return value == null ? null : Number(value);
}

function escapeLabel(value) {
  return String(value || '').replace(/(["\\\n])/g, '\\$1');
}

function printJson(payload) {
  console.log(JSON.stringify(payload, null, pretty ? 2 : 0));
}
