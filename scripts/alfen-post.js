#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');

const API_HEADER = 'application/json';

function normalizeRequestBody(rawBody) {
  try {
    return JSON.stringify(JSON.parse(String(rawBody)));
  } catch {
    return String(rawBody);
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;

    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    i += 1;
  }
  return args;
}

function readJsonFileIfExists(filePath) {
  if (!filePath) return null;
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function resolveCredentials(args) {
  const profileArg = typeof args.profile === 'string' && args.profile.trim().length > 0
    ? args.profile
    : '.alfen-debug.json';
  const profilePath = path.resolve(String(profileArg));
  const profile = readJsonFileIfExists(profilePath) || {};

  return {
    ip: String(args.ip || process.env.ALFEN_IP || profile.ip || '').trim(),
    user: String(args.user || process.env.ALFEN_USER || profile.user || profile.username || '').trim(),
    pass: String(args.pass || process.env.ALFEN_PASS || profile.pass || profile.password || '').trim(),
    profilePath,
  };
}

function normalizeApiPath(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Missing --path. Example: --path /api/prop');
  return raw.startsWith('/') ? raw : `/${raw}`;
}

function resolveBody(args) {
  const hasBody = typeof args.body === 'string';
  const hasBodyFile = typeof args['body-file'] === 'string';

  if (hasBody && hasBodyFile) {
    throw new Error('Use either --body or --body-file, not both.');
  }
  if (!hasBody && !hasBodyFile) {
    throw new Error('Missing body. Use --body or --body-file.');
  }

  if (hasBody) return normalizeRequestBody(args.body);

  const filePath = path.resolve(String(args['body-file']));
  if (!fs.existsSync(filePath)) {
    throw new Error(`Body file not found: ${filePath}`);
  }
  return normalizeRequestBody(fs.readFileSync(filePath, 'utf8'));
}

function createClient(ip) {
  const url = new URL(`https://${ip}`);
  return {
    hostname: url.hostname,
    port: url.port ? Number(url.port) : 443,
    agent: new https.Agent({
      keepAlive: true,
      maxSockets: 1,
      rejectUnauthorized: false,
    }),
  };
}

async function requestAny(client, requestPath, method, body) {
  const headers = {
    'Connection': 'Keep-Alive',
    'Content-Type': API_HEADER,
    'User-Agent': '',
    'Accept': 'application/json',
    'Accept-Encoding': '',
  };

  if (body !== undefined) {
    headers['Content-Length'] = Buffer.byteLength(body).toString();
  }

  console.log(requestPath);
  console.log(body);

  const raw = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: client.hostname,
      port: client.port,
      path: requestPath,
      method,
      headers,
      agent: client.agent,
      rejectUnauthorized: false,
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, body: data });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error(`Request timed out: ${method} ${requestPath}`));
    });

    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });

  let parsed;
  try {
    parsed = JSON.parse(raw.body);
  } catch {
    parsed = raw.body;
  }

  return {
    statusCode: raw.statusCode,
    raw: raw.body,
    parsed,
  };
}

async function login(agent, user, pass) {
  const response = await requestAny(
    agent,
    '/api/login',
    'POST',
    JSON.stringify({ username: user, password: pass }),
  );

  if (response.statusCode !== 200) {
    throw new Error(`Login failed with HTTP ${response.statusCode}: ${response.raw}`);
  }
}

async function logout(agent) {
  try {
    const body = '{}';
    await requestAny(agent, '/api/logout', 'POST', body);
  } catch {
    // Best effort logout.
  }
}

function printUsage() {
  console.log('Authenticated POST helper for Alfen local API');
  console.log('');
  console.log('Usage:');
  console.log('  node scripts/alfen-post.js --path /api/prop --body "{\"2129_0\":{\"id\":\"2129_0\",\"value\":16}}"');
  console.log('  node scripts/alfen-post.js --profile .alfen-debug.json --path /api/chargingprofiles?add --body-file /tmp/payload.json');
  console.log('  node scripts/alfen-post.js --path /api/prop --body-file ./payload.json --raw');
  console.log('');
  console.log('Credential precedence: CLI args > env vars > profile file');
  console.log('  --ip, --user, --pass, --profile <file>');
  console.log('  env: ALFEN_IP, ALFEN_USER, ALFEN_PASS');
  console.log('');
  console.log('Body options:');
  console.log('  --body <json/text> or --body-file <file>');
  console.log('');
  console.log('Output:');
  console.log('  JSON pretty output by default, or raw response text with --raw');
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help || args.h) {
    printUsage();
    return;
  }

  const { ip, user, pass, profilePath } = resolveCredentials(args);
  if (!ip || !user || !pass) {
    throw new Error(`Missing credentials. Use --ip/--user/--pass, env vars, or profile file at ${profilePath}.`);
  }

  const requestPath = normalizeApiPath(args.path);
  const body = resolveBody(args);

  const client = createClient(ip);

  try {
    await login(client, user, pass);

    const response = await requestAny(client, requestPath, 'POST', body);
    console.log(`POST ${requestPath} -> HTTP ${response.statusCode}`);

    if (args.raw) {
      console.log(response.raw);
    } else {
      if (typeof response.parsed === 'string') {
        console.log(response.parsed);
      } else {
        console.log(JSON.stringify(response.parsed, null, 2));
      }
    }

    if (response.statusCode !== 200) {
      process.exitCode = 1;
    }
  } finally {
    await logout(client);
    client.agent.destroy();
  }
}

main().catch((error) => {
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
});
