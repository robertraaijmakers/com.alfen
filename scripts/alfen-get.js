#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const API_HEADER = 'alfen/json; charset=utf-8';

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
  if (!raw) throw new Error('Missing --path. Example: --path /api/info');
  return raw.startsWith('/') ? raw : `/${raw}`;
}

async function requestAny(host, agent, requestPath, method, body) {
  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': 'node-https',
      'Content-Type': API_HEADER,
    };

    if (body !== undefined) {
      headers['Content-Length'] = Buffer.byteLength(body).toString();
    }

    const req = https.request(
      {
        host,
        port: 443,
        path: requestPath,
        method,
        headers,
        agent,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = raw;
          }

          resolve({
            statusCode: res.statusCode,
            raw,
            parsed,
          });
        });
      },
    );

    req.on('error', reject);

    if (body !== undefined) {
      req.write(body);
    }

    req.end();
  });
}

async function login(host, agent, user, pass) {
  const response = await requestAny(
    host,
    agent,
    '/api/login',
    'POST',
    JSON.stringify({ username: user, password: pass }),
  );

  if (response.statusCode !== 200) {
    throw new Error(`Login failed with HTTP ${response.statusCode}: ${response.raw}`);
  }
}

async function logout(host, agent) {
  try {
    await requestAny(host, agent, '/api/logout', 'POST');
  } catch {
    // Best effort logout.
  }
}

function printUsage() {
  console.log('Authenticated GET helper for Alfen local API');
  console.log('');
  console.log('Usage:');
  console.log('  node scripts/alfen-get.js --path /api/info');
  console.log('  node scripts/alfen-get.js --profile .alfen-debug.json --path /api/chargingprofiles?id_list=1');
  console.log('  node scripts/alfen-get.js --path /api/info --raw');
  console.log('');
  console.log('Credential precedence: CLI args > env vars > profile file');
  console.log('  --ip, --user, --pass, --profile <file>');
  console.log('  env: ALFEN_IP, ALFEN_USER, ALFEN_PASS');
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

  const agent = new https.Agent({
    keepAlive: true,
    maxSockets: 1,
    rejectUnauthorized: false,
  });

  try {
    await login(ip, agent, user, pass);

    const response = await requestAny(ip, agent, requestPath, 'GET');
    console.log(`GET ${requestPath} -> HTTP ${response.statusCode}`);

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
    await logout(ip, agent);
    agent.destroy();
  }
}

main().catch((error) => {
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
});
